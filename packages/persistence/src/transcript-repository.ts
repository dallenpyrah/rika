import { Context, Effect, Layer, Ref, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { ThreadId } from "./thread-schema"
import { Status, Turn, TurnId } from "./turn-schema"

export const TranscriptEvent = Schema.Struct({
  cursor: Schema.String,
  sequence: Schema.Finite,
  type: Schema.String,
  createdAt: Schema.Finite,
  text: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export type TranscriptEvent = typeof TranscriptEvent.Type

export interface Entry {
  readonly turn: Turn
  readonly events: ReadonlyArray<TranscriptEvent>
  readonly revision: number
  readonly projectionVersion: 1
  readonly oldestCursor: string | undefined
  readonly checkpointCursor: string | undefined
}

export const EntrySchema = Schema.Struct({
  turn: Turn,
  events: Schema.Array(TranscriptEvent),
  revision: Schema.Finite,
  projectionVersion: Schema.Literal(1),
  oldestCursor: Schema.UndefinedOr(Schema.String),
  checkpointCursor: Schema.UndefinedOr(Schema.String),
})

export interface PageCursor {
  readonly createdAt: number
  readonly turnId: TurnId
}

export interface PageOptions {
  readonly before?: PageCursor | undefined
  readonly limit?: number
}

export interface Page {
  readonly entries: ReadonlyArray<Entry>
  readonly hasOlder: boolean
  readonly oldestCursor: PageCursor | undefined
}

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("TranscriptRepositoryError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly get: (turnId: TurnId) => Effect.Effect<Entry | undefined, RepositoryError>
  readonly replace: (turn: Turn, events: ReadonlyArray<TranscriptEvent>) => Effect.Effect<Entry, RepositoryError>
  readonly append: (turn: Turn, event: TranscriptEvent) => Effect.Effect<Entry, RepositoryError>
  readonly page: (threadId: ThreadId, options?: PageOptions) => Effect.Effect<Page, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/transcript-repository/Service") {}

const Row = Schema.Struct({
  turn_id: Schema.String,
  thread_id: Schema.String,
  prompt: Schema.String,
  status: Schema.String,
  events_json: Schema.String,
  revision: Schema.Finite,
  projection_version: Schema.Literal(1),
  oldest_cursor: Schema.NullOr(Schema.String),
  checkpoint_cursor: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
})
const EventsJson = Schema.fromJsonString(Schema.Array(TranscriptEvent))
const error = (cause: unknown) => RepositoryError.make({ message: String(cause) })
const clone = (entry: Entry): Entry => structuredClone(entry)
const pageSize = (limit: number | undefined) => Math.min(200, Math.max(1, Math.floor(limit ?? 50)))
const cursorFor = (entry: Entry | undefined): PageCursor | undefined =>
  entry === undefined ? undefined : { createdAt: entry.turn.createdAt, turnId: entry.turn.id }
const entry = (turn: Turn, events: ReadonlyArray<TranscriptEvent>, revision: number): Entry => ({
  turn: structuredClone(turn),
  events: structuredClone(events),
  revision,
  projectionVersion: 1,
  oldestCursor: events[0]?.cursor,
  checkpointCursor: events.at(-1)?.cursor,
})
const decode = (value: unknown) =>
  Effect.gen(function* () {
    const row = yield* Schema.decodeUnknownEffect(Row)(value)
    const status = yield* Schema.decodeUnknownEffect(Status)(row.status)
    const events = yield* Schema.decodeUnknownEffect(EventsJson)(row.events_json)
    return {
      turn: {
        id: TurnId.make(row.turn_id),
        threadId: ThreadId.make(row.thread_id),
        prompt: row.prompt,
        status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      events,
      revision: row.revision,
      projectionVersion: row.projection_version,
      oldestCursor: row.oldest_cursor ?? undefined,
      checkpointCursor: row.checkpoint_cursor ?? undefined,
    }
  }).pipe(Effect.mapError(error))

const makeMemory = Effect.gen(function* () {
  const state = yield* Ref.make(new Map<TurnId, Entry>())
  const get = Effect.fn("TranscriptRepository.get")(function* (turnId: TurnId) {
    const found = (yield* Ref.get(state)).get(turnId)
    return found === undefined ? undefined : clone(found)
  })
  return Service.of({
    get,
    replace: Effect.fn("TranscriptRepository.replace")(function* (turn, events) {
      const current = yield* get(turn.id)
      const next = entry(turn, events, (current?.revision ?? 0) + 1)
      yield* Ref.update(state, (entries) => new Map(entries).set(turn.id, next))
      return clone(next)
    }),
    append: Effect.fn("TranscriptRepository.append")(function* (turn, event) {
      const current = yield* get(turn.id)
      if (current !== undefined && current.events.some((item) => item.cursor === event.cursor)) return current
      const next = entry(turn, [...(current?.events ?? []), event], (current?.revision ?? 0) + 1)
      yield* Ref.update(state, (entries) => new Map(entries).set(turn.id, next))
      return clone(next)
    }),
    page: Effect.fn("TranscriptRepository.page")(function* (threadId, options = {}) {
      const limit = pageSize(options.limit)
      const descending = [...(yield* Ref.get(state)).values()]
        .filter(
          (item) =>
            item.turn.threadId === threadId &&
            (options.before === undefined ||
              item.turn.createdAt < options.before.createdAt ||
              (item.turn.createdAt === options.before.createdAt && item.turn.id < options.before.turnId)),
        )
        .toSorted(
          (left, right) => right.turn.createdAt - left.turn.createdAt || right.turn.id.localeCompare(left.turn.id),
        )
      const entries = descending.slice(0, limit).reverse().map(clone)
      return { entries, hasOlder: descending.length > limit, oldestCursor: cursorFor(entries[0]) }
    }),
  })
})

export const memoryLayer = Layer.effect(Service, makeMemory)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const get = Effect.fn("TranscriptRepository.get")(function* (turnId: TurnId) {
      const rows = yield* sql`SELECT * FROM rika_transcript_entries WHERE turn_id = ${turnId}`.pipe(
        Effect.mapError(error),
      )
      return rows[0] === undefined ? undefined : yield* decode(rows[0])
    })
    const replace = Effect.fn("TranscriptRepository.replace")(function* (
      turn: Turn,
      events: ReadonlyArray<TranscriptEvent>,
    ) {
      const encoded = yield* Schema.encodeEffect(EventsJson)(events).pipe(Effect.mapError(error))
      yield* sql`INSERT INTO rika_transcript_entries (turn_id, thread_id, prompt, status, events_json, revision, projection_version, oldest_cursor, checkpoint_cursor, created_at, updated_at)
        VALUES (${turn.id}, ${turn.threadId}, ${turn.prompt}, ${turn.status}, ${encoded}, 1, 1, ${events[0]?.cursor ?? null}, ${events.at(-1)?.cursor ?? null}, ${turn.createdAt}, ${turn.updatedAt})
        ON CONFLICT(turn_id) DO UPDATE SET thread_id = excluded.thread_id, prompt = excluded.prompt, status = excluded.status,
          events_json = excluded.events_json, revision = rika_transcript_entries.revision + 1,
          projection_version = excluded.projection_version, oldest_cursor = excluded.oldest_cursor,
          checkpoint_cursor = excluded.checkpoint_cursor, updated_at = excluded.updated_at`.pipe(Effect.mapError(error))
      const stored = yield* get(turn.id)
      if (stored === undefined) return yield* RepositoryError.make({ message: `Transcript ${turn.id} was not stored` })
      return stored
    })
    return Service.of({
      get,
      replace,
      append: Effect.fn("TranscriptRepository.append")(function* (turn, nextEvent) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const current = yield* get(turn.id)
              if (current !== undefined && current.events.some((item) => item.cursor === nextEvent.cursor))
                return current
              return yield* replace(turn, [...(current?.events ?? []), nextEvent])
            }),
          )
          .pipe(Effect.mapError(error))
      }),
      page: Effect.fn("TranscriptRepository.page")(function* (threadId, options = {}) {
        const limit = pageSize(options.limit)
        const rows =
          options.before === undefined
            ? yield* sql`SELECT * FROM rika_transcript_entries WHERE thread_id = ${threadId} ORDER BY created_at DESC, turn_id DESC LIMIT ${limit + 1}`.pipe(
                Effect.mapError(error),
              )
            : yield* sql`SELECT * FROM rika_transcript_entries WHERE thread_id = ${threadId} AND (created_at < ${options.before.createdAt} OR (created_at = ${options.before.createdAt} AND turn_id < ${options.before.turnId})) ORDER BY created_at DESC, turn_id DESC LIMIT ${limit + 1}`.pipe(
                Effect.mapError(error),
              )
        const entries = (yield* Effect.all(rows.slice(0, limit).map(decode))).reverse()
        return { entries, hasOlder: rows.length > limit, oldestCursor: cursorFor(entries[0]) }
      }),
    })
  }),
)
