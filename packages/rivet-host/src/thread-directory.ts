import { ThreadDigest } from "@rika/agent"
import { Common, Event, Ids, Message } from "@rika/schema"
import { ThreadProjection } from "@rika/persistence"
import { Action, Actor, Client as RivetClient, Registry, RivetError } from "@rivetkit/effect"
import { Context, Effect, Layer, Schema, Semaphore, SynchronizedRef } from "effect"
import { db as rivetDb, type RawAccess } from "rivetkit/db"
import { retryTransientRivetErrors } from "./thread-client"

export class ThreadDirectoryError extends Schema.TaggedErrorClass<ThreadDirectoryError>()("ThreadDirectoryError", {
  message: Schema.String,
  operation: Schema.String,
  thread_id: Schema.optional(Ids.ThreadId),
}) {}

export interface Interface {
  readonly applyEvents: (events: ReadonlyArray<Event.Event>) => Effect.Effect<void, ThreadDirectoryError>
  readonly listThreads: () => Effect.Effect<ReadonlyArray<ThreadProjection.ThreadSummary>, ThreadDirectoryError>
  readonly listThreadFiles: (
    input?: ThreadProjection.ThreadFilesInput,
  ) => Effect.Effect<ReadonlyArray<ThreadProjection.ThreadFile>, ThreadDirectoryError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/rivet-host/ThreadDirectory") {}

export interface ApplyEventsPayload extends Schema.Schema.Type<typeof ApplyEventsPayload> {}
export const ApplyEventsPayload = Schema.Struct({
  events: Schema.Array(Event.Event),
}).annotate({ identifier: "Rika.RivetHost.ThreadDirectory.ApplyEventsPayload" })

export interface ListThreadsPayload extends Schema.Schema.Type<typeof ListThreadsPayload> {}
export const ListThreadsPayload = Schema.Struct({}).annotate({
  identifier: "Rika.RivetHost.ThreadDirectory.ListThreadsPayload",
})

export interface ApplyEventsResult extends Schema.Schema.Type<typeof ApplyEventsResult> {}
export const ApplyEventsResult = Schema.Struct({}).annotate({
  identifier: "Rika.RivetHost.ThreadDirectory.ApplyEventsResult",
})

export const ThreadDirectoryActorError = ThreadDirectoryError.annotate({
  identifier: "Rika.RivetHost.ThreadDirectory.Error",
})
export type ThreadDirectoryActorError = typeof ThreadDirectoryActorError.Type

export const ApplyEvents = Action.make("ApplyEvents", {
  payload: ApplyEventsPayload,
  success: ApplyEventsResult,
  error: ThreadDirectoryActorError,
})

export const ListThreads = Action.make("ListThreads", {
  payload: ListThreadsPayload,
  success: Schema.Array(ThreadProjection.ThreadSummary),
  error: ThreadDirectoryActorError,
})

export const ListThreadFiles = Action.make("ListThreadFiles", {
  payload: ThreadProjection.ThreadFilesInput,
  success: Schema.Array(ThreadProjection.ThreadFile),
  error: ThreadDirectoryActorError,
})

export const ThreadDirectoryActor = Actor.make("ThreadDirectoryActor", {
  actions: [ApplyEvents, ListThreads, ListThreadFiles],
})

interface DirectoryState {
  readonly summaries: Map<string, DirectoryRecord>
  readonly files: Map<string, Map<string, ThreadProjection.ThreadFile>>
}

interface DirectoryRecord {
  readonly summary: ThreadProjection.ThreadSummary
  readonly last_sequence: number
}

interface SummaryRow extends Record<string, unknown> {
  readonly thread_id: string
  readonly last_sequence: number
  readonly payload: string
}

interface FileRow extends Record<string, unknown> {
  readonly thread_id: string
  readonly path: string
  readonly first_seen_at: number
  readonly last_seen_at: number
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make({
      summaries: new Map<string, DirectoryRecord>(),
      files: new Map<string, Map<string, ThreadProjection.ThreadFile>>(),
    })
    return Service.of({
      applyEvents: Effect.fn("ThreadDirectory.applyEvents")(function* (events: ReadonlyArray<Event.Event>) {
        yield* SynchronizedRef.updateEffect(state, (current) => Effect.succeed(applyDirectoryEvents(current, events)))
      }),
      listThreads: Effect.fn("ThreadDirectory.listThreads")(function* () {
        const current = yield* SynchronizedRef.get(state)
        return [...current.summaries.values()].map((record) => record.summary).toSorted(compareSummaries)
      }),
      listThreadFiles: Effect.fn("ThreadDirectory.listThreadFiles")(function* (
        input: ThreadProjection.ThreadFilesInput = {},
      ) {
        const current = yield* SynchronizedRef.get(state)
        const threadIds =
          input.thread_ids === undefined ? undefined : new Set(input.thread_ids.map((threadId) => String(threadId)))
        return [...current.files.values()]
          .flatMap((files) => [...files.values()])
          .filter((file) => input.thread_id === undefined || file.thread_id === input.thread_id)
          .filter((file) => threadIds === undefined || threadIds.has(file.thread_id))
          .toSorted(compareFiles)
      }),
    })
  }),
)

export const actorDb = rivetDb({
  onMigrate: async (database) => {
    await database.execute(`
      create table if not exists thread_summaries (
        thread_id text primary key,
        workspace_id text not null,
        updated_at integer not null,
        last_sequence integer not null,
        payload text not null
      )
    `)
    await database.execute("create index if not exists thread_summaries_updated on thread_summaries(updated_at)")
    await database.execute(`
      create table if not exists thread_files (
        thread_id text not null,
        path text not null,
        first_seen_at integer not null,
        last_seen_at integer not null,
        primary key(thread_id, path)
      )
    `)
    await database.execute("create index if not exists thread_files_thread on thread_files(thread_id)")
  },
})

export const actorLayer: Layer.Layer<never, never, Registry.Registry> = ThreadDirectoryActor.toLayer(
  Effect.fnUntraced(function* ({ rawRivetkitContext }) {
    const database = rawRivetkitContext.db
    const mutationLock = yield* Semaphore.make(1)
    return ThreadDirectoryActor.of({
      ApplyEvents: ({ payload }) =>
        mutationLock.withPermit(applyEventsToDb(database, payload.events).pipe(Effect.as({}))),
      ListThreads: () =>
        mutationLock.withPermit(
          readDirectoryState(database).pipe(
            Effect.map((state) =>
              [...state.summaries.values()].map((record) => record.summary).toSorted(compareSummaries),
            ),
          ),
        ),
      ListThreadFiles: ({ payload }) =>
        mutationLock.withPermit(
          readDirectoryState(database).pipe(Effect.map((state) => listFilesFromState(state, payload))),
        ),
    })
  }),
  {
    db: actorDb,
    name: "Rika Thread Directory",
    icon: "list",
  },
)

export const liveLayer: Layer.Layer<Service, never, RivetClient.Client> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const accessor = yield* ThreadDirectoryActor.client
    const handle = accessor.getOrCreate("global")
    return Service.of({
      applyEvents: Effect.fn("ThreadDirectory.live.applyEvents")(function* (events: ReadonlyArray<Event.Event>) {
        yield* handle
          .ApplyEvents({ events })
          .pipe(retryTransientRivetErrors)
          .pipe(Effect.mapError((error) => toDirectoryClientError(error, "ApplyEvents", events[0]?.thread_id)))
      }),
      listThreads: Effect.fn("ThreadDirectory.live.listThreads")(function* () {
        return yield* handle
          .ListThreads({})
          .pipe(retryTransientRivetErrors)
          .pipe(Effect.mapError((error) => toDirectoryClientError(error, "ListThreads")))
      }),
      listThreadFiles: Effect.fn("ThreadDirectory.live.listThreadFiles")(function* (
        input: ThreadProjection.ThreadFilesInput = {},
      ) {
        return yield* handle
          .ListThreadFiles(input)
          .pipe(retryTransientRivetErrors)
          .pipe(Effect.mapError((error) => toDirectoryClientError(error, "ListThreadFiles", input.thread_id)))
      }),
    })
  }),
)

export const apply = Effect.fn("ThreadDirectory.applyEvents.call")(function* (events: ReadonlyArray<Event.Event>) {
  const directory = yield* Service
  return yield* directory.applyEvents(events)
})

export const listThreads = Effect.fn("ThreadDirectory.listThreads.call")(function* () {
  const directory = yield* Service
  return yield* directory.listThreads()
})

export const listThreadFiles = Effect.fn("ThreadDirectory.listThreadFiles.call")(function* (
  input: ThreadProjection.ThreadFilesInput = {},
) {
  const directory = yield* Service
  return yield* directory.listThreadFiles(input)
})

export const diffStatsFromEvents = (events: ReadonlyArray<Event.Event>): ThreadProjection.ThreadDiffStats =>
  events.reduce(
    (diff, event) =>
      event.type === "tool.call.completed" ? addDiffStats(diff, diffStatsFromValue(event.data.result.output)) : diff,
    emptyDiff,
  )

const applyDirectoryEvents = (state: DirectoryState, events: ReadonlyArray<Event.Event>): DirectoryState =>
  events.reduce(applyEvent, cloneState(state))

const applyEventsToDb = (
  database: RawAccess,
  events: ReadonlyArray<Event.Event>,
): Effect.Effect<void, ThreadDirectoryError> =>
  Effect.gen(function* () {
    const current = yield* readDirectoryState(database)
    const next = applyDirectoryEvents(current, events)
    yield* writeDirectoryState(database, next)
  })

const readDirectoryState = (database: RawAccess): Effect.Effect<DirectoryState, ThreadDirectoryError> =>
  Effect.tryPromise({
    try: async () => {
      const summaryRows = await database.execute<SummaryRow>(
        "select thread_id, last_sequence, payload from thread_summaries",
      )
      const fileRows = await database.execute<FileRow>(
        "select thread_id, path, first_seen_at, last_seen_at from thread_files order by thread_id asc, path asc",
      )
      const summaries = new Map<string, DirectoryRecord>()
      const files = new Map<string, Map<string, ThreadProjection.ThreadFile>>()
      for (const row of summaryRows) {
        summaries.set(row.thread_id, {
          summary: decodeSummary(row.payload),
          last_sequence: row.last_sequence,
        })
      }
      for (const row of fileRows) {
        const current = files.get(row.thread_id) ?? new Map<string, ThreadProjection.ThreadFile>()
        current.set(row.path, {
          thread_id: Ids.ThreadId.make(row.thread_id),
          path: row.path,
          first_seen_at: row.first_seen_at,
          last_seen_at: row.last_seen_at,
        })
        files.set(row.thread_id, current)
      }
      return { summaries, files }
    },
    catch: (cause) => directoryError(cause, "readDirectoryState"),
  })

const writeDirectoryState = (database: RawAccess, state: DirectoryState): Effect.Effect<void, ThreadDirectoryError> =>
  Effect.tryPromise({
    try: async () => {
      let committed = false
      await database.execute("begin immediate")
      try {
        await database.execute("delete from thread_files")
        await database.execute("delete from thread_summaries")
        for (const record of state.summaries.values()) {
          await database.execute(
            `insert into thread_summaries (
              thread_id,
              workspace_id,
              updated_at,
              last_sequence,
              payload
            ) values (?, ?, ?, ?, ?)`,
            record.summary.thread_id,
            record.summary.workspace_id,
            record.summary.updated_at,
            record.last_sequence,
            encodeSummary(record.summary),
          )
        }
        for (const files of state.files.values()) {
          for (const file of files.values()) {
            await database.execute(
              `insert into thread_files (
                thread_id,
                path,
                first_seen_at,
                last_seen_at
              ) values (?, ?, ?, ?)`,
              file.thread_id,
              file.path,
              file.first_seen_at,
              file.last_seen_at,
            )
          }
        }
        await database.execute("commit")
        committed = true
      } finally {
        if (!committed) await database.execute("rollback").catch(() => undefined)
      }
    },
    catch: (cause) => directoryError(cause, "writeDirectoryState"),
  })

const listFilesFromState = (state: DirectoryState, input: ThreadProjection.ThreadFilesInput = {}) => {
  const threadIds =
    input.thread_ids === undefined ? undefined : new Set(input.thread_ids.map((threadId) => String(threadId)))
  return [...state.files.values()]
    .flatMap((files) => [...files.values()])
    .filter((file) => input.thread_id === undefined || file.thread_id === input.thread_id)
    .filter((file) => threadIds === undefined || threadIds.has(file.thread_id))
    .toSorted(compareFiles)
}

const applyEvent = (state: DirectoryState, event: Event.Event): DirectoryState => {
  const current = state.summaries.get(event.thread_id)
  if (current === undefined) {
    if (event.type !== "thread.created") return state
    state.summaries.set(event.thread_id, createdSummary(event))
    return state
  }
  if (event.sequence <= current.last_sequence) return state
  if (event.sequence !== current.last_sequence + 1) return state
  state.summaries.set(event.thread_id, applySummaryEvent(current.summary, event))
  applyFileEntries(state, event)
  return state
}

const applySummaryEvent = (summary: ThreadProjection.ThreadSummary, event: Event.Event): DirectoryRecord => {
  switch (event.type) {
    case "message.added":
      return withSequence(messageSummary(summary, event), event)
    case "tool.call.completed":
      return withSequence(toolCompletedSummary(summary, event), event)
    case "turn.started":
      return withSequence(
        {
          ...sequenceSummary(summary, event),
          active_turn_id: event.turn_id,
          active_turn_status: "active",
          ...(event.data.user_id === undefined ? {} : { last_user_id: event.data.user_id }),
        },
        event,
      )
    case "turn.failed":
      return withSequence(terminalTurnSummary(summary, event, "failed"), event)
    case "turn.completed":
      return withSequence(
        {
          ...terminalTurnSummary(summary, event, "completed"),
          ...(event.data.usage?.input_tokens === undefined ? {} : { context_tokens: event.data.usage.input_tokens }),
          ...(event.data.model === undefined ? {} : { last_model: event.data.model }),
        },
        event,
      )
    case "model.stream.chunk":
    case "model.reasoning.delta":
      return withSequence({ ...sequenceSummary(summary, event), last_model: event.data.model }, event)
    case "thread.archived":
      return withSequence({ ...sequenceSummary(summary, event), archived: true }, event)
    case "thread.unarchived":
      return withSequence({ ...sequenceSummary(summary, event), archived: false }, event)
    case "thread.visibility.set":
      return withSequence({ ...sequenceSummary(summary, event), visibility: event.data.visibility }, event)
    default:
      return withSequence(sequenceSummary(summary, event), event)
  }
}

const createdSummary = (event: Event.ThreadCreated): DirectoryRecord => ({
  summary: {
    thread_id: event.thread_id,
    workspace_id: event.data.workspace_id,
    ...(event.data.user_id === undefined ? {} : { user_id: event.data.user_id, last_user_id: event.data.user_id }),
    ...(event.data.title_text === undefined ? {} : { title_text: event.data.title_text }),
    diff: { additions: 0, modifications: 0, deletions: 0 },
    archived: false,
    visibility: "private",
    created_at: event.created_at,
    updated_at: event.created_at,
  },
  last_sequence: event.sequence,
})

const messageSummary = (
  summary: ThreadProjection.ThreadSummary,
  event: Event.MessageAdded,
): ThreadProjection.ThreadSummary => {
  const text = Message.displayText(event.data.message)
  const userId = messageUserId(event)
  return {
    ...sequenceSummary(summary, event),
    latest_message_id: event.data.message.id,
    latest_message_role: event.data.message.role,
    latest_message_text: text,
    latest_message_created_at: event.data.message.created_at,
    ...(summary.title_text === undefined && event.data.message.role === "user" ? titleText(text) : {}),
    ...(userId === undefined ? {} : { last_user_id: userId }),
  }
}

const toolCompletedSummary = (
  summary: ThreadProjection.ThreadSummary,
  event: Event.ToolCallCompleted,
): ThreadProjection.ThreadSummary => {
  const diff = diffStatsFromValue(event.data.result.output)
  return {
    ...sequenceSummary(summary, event),
    diff: addDiffStats(summary.diff, diff),
  }
}

const terminalTurnSummary = (
  summary: ThreadProjection.ThreadSummary,
  event: Event.TurnCompleted | Event.TurnFailed,
  status: "completed" | "failed",
): ThreadProjection.ThreadSummary => {
  if (
    summary.active_turn_id !== undefined &&
    summary.active_turn_id !== event.turn_id &&
    summary.active_turn_status !== undefined
  ) {
    return sequenceSummary(summary, event)
  }
  if (summary.active_turn_status === "completed" || summary.active_turn_status === "failed") {
    return sequenceSummary(summary, event)
  }
  return { ...sequenceSummary(summary, event), active_turn_id: event.turn_id, active_turn_status: status }
}

const sequenceSummary = (
  summary: ThreadProjection.ThreadSummary,
  event: Event.Event,
): ThreadProjection.ThreadSummary => ({
  ...summary,
  updated_at: event.created_at,
})

const withSequence = (summary: ThreadProjection.ThreadSummary, event: Event.Event): DirectoryRecord => ({
  summary,
  last_sequence: event.sequence,
})

const applyFileEntries = (state: DirectoryState, event: Event.Event) => {
  const paths = ThreadDigest.fileEntries([event])
  if (paths.length === 0) return
  const current = state.files.get(event.thread_id) ?? new Map<string, ThreadProjection.ThreadFile>()
  for (const path of paths) {
    const existing = current.get(path)
    current.set(path, {
      thread_id: event.thread_id,
      path,
      first_seen_at: existing?.first_seen_at ?? event.created_at,
      last_seen_at: event.created_at,
    })
  }
  state.files.set(event.thread_id, current)
}

const titleText = (text: string) => {
  const value = text.replace(/\r\n?/g, "\n").trim()
  if (value.length === 0) return {}
  if (isRawToolPayload(value)) return {}
  return { title_text: oneLine(value, 96) }
}

const messageUserId = (event: Event.MessageAdded): Ids.UserId | undefined => {
  if (event.data.message.role !== "user") return undefined
  const userId = event.data.message.metadata?.user_id
  return typeof userId === "string" && userId.length > 0 ? Ids.UserId.make(userId) : undefined
}

const cloneState = (state: DirectoryState): DirectoryState => ({
  summaries: new Map(state.summaries),
  files: new Map([...state.files.entries()].map(([threadId, files]) => [threadId, new Map(files)])),
})

const compareSummaries = (left: ThreadProjection.ThreadSummary, right: ThreadProjection.ThreadSummary) =>
  right.updated_at - left.updated_at || left.thread_id.localeCompare(right.thread_id)

const compareFiles = (left: ThreadProjection.ThreadFile, right: ThreadProjection.ThreadFile) =>
  left.thread_id.localeCompare(right.thread_id) || left.path.localeCompare(right.path)

const emptyDiff: ThreadProjection.ThreadDiffStats = { additions: 0, modifications: 0, deletions: 0 }

const diffStatsFromValue = (value: Common.JsonValue | undefined): ThreadProjection.ThreadDiffStats => {
  if (Array.isArray(value)) {
    return value.reduce(addNestedDiffStats, emptyDiff)
  }
  if (!isJsonObject(value)) return emptyDiff
  if (isPierreDiff(value)) return diffStatsFromFileDiff(value.file_diff)
  return Object.values(value).reduce(addNestedDiffStats, emptyDiff)
}

const diffStatsFromFileDiff = (value: Common.JsonValue | undefined): ThreadProjection.ThreadDiffStats => {
  if (!isJsonObject(value)) return emptyDiff
  return arrayField(value, "hunks")?.filter(isJsonObject).reduce(addHunkDiffStats, emptyDiff) ?? emptyDiff
}

const diffStatsFromHunk = (hunk: Record<string, Common.JsonValue>): ThreadProjection.ThreadDiffStats =>
  arrayField(hunk, "hunkContent")?.filter(isJsonObject).reduce(addHunkContentDiffStats, emptyDiff) ?? emptyDiff

const addNestedDiffStats = (
  total: ThreadProjection.ThreadDiffStats,
  item: Common.JsonValue,
): ThreadProjection.ThreadDiffStats => addDiffStats(total, diffStatsFromValue(item))

const addHunkDiffStats = (
  total: ThreadProjection.ThreadDiffStats,
  hunk: Record<string, Common.JsonValue>,
): ThreadProjection.ThreadDiffStats => addDiffStats(total, diffStatsFromHunk(hunk))

const addHunkContentDiffStats = (
  total: ThreadProjection.ThreadDiffStats,
  content: Record<string, Common.JsonValue>,
): ThreadProjection.ThreadDiffStats => {
  if (content.type !== "change") return total
  const additions = numberField(content, "additions") ?? 0
  const deletions = numberField(content, "deletions") ?? 0
  return addDiffStats(total, { additions, modifications: Math.min(additions, deletions), deletions })
}

const addDiffStats = (
  left: ThreadProjection.ThreadDiffStats,
  right: ThreadProjection.ThreadDiffStats,
): ThreadProjection.ThreadDiffStats => ({
  additions: left.additions + right.additions,
  modifications: left.modifications + right.modifications,
  deletions: left.deletions + right.deletions,
})

const isPierreDiff = (value: Record<string, Common.JsonValue>) =>
  value.kind === "diff" && value.renderer === "@pierre/diffs"

const isJsonObject = (value: Common.JsonValue | undefined): value is Record<string, Common.JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const arrayField = (
  value: Record<string, Common.JsonValue>,
  key: string,
): ReadonlyArray<Common.JsonValue> | undefined => (Array.isArray(value[key]) ? value[key] : undefined)

const numberField = (value: Record<string, Common.JsonValue>, key: string) =>
  typeof value[key] === "number" ? value[key] : undefined

const encodeSummary = (summary: ThreadProjection.ThreadSummary) => JSON.stringify(summary)

const decodeSummary = (payload: string) => Schema.decodeUnknownSync(ThreadProjection.ThreadSummary)(JSON.parse(payload))

const directoryError = (cause: unknown, operation: string, threadId?: Ids.ThreadId) =>
  new ThreadDirectoryError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    ...(threadId === undefined ? {} : { thread_id: threadId }),
  })

const toDirectoryClientError = (
  cause: ThreadDirectoryError | RivetError.RivetError,
  operation: string,
  threadId?: Ids.ThreadId,
) => {
  if (cause instanceof ThreadDirectoryError) return cause
  return directoryError(cause, operation, threadId)
}

const oneLine = (value: string, max: number): string => {
  const text = value.replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 3))}...`
}

const isRawToolPayload = (text: string): boolean => {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false
  return trimmed.includes('"tool_call"') || trimmed.includes('"tool_result"')
}
