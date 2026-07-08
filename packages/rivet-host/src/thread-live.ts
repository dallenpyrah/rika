import { AgentLoop, CompactionService, WorkspaceAccess } from "@rika/agent"
import { IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Database, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Codec, Event, Ids } from "@rika/schema"
import { Registry, State } from "@rivetkit/effect"
import { Effect, Fiber, Layer, Option, Schema, Semaphore, Stream } from "effect"
import { db as rivetDb, type RawAccess } from "rivetkit/db"
import {
  AppendMirroredEventsPayload,
  EnsureThreadPayload,
  GetEventsPayload,
  ImportForkThreadPayload,
  InterruptTurnPayload,
  PrepareForkThreadPayload,
  SetVisibilityPayload,
  StartTurnPayload,
  ThreadActor,
  ThreadActorActiveTurn,
  ThreadActorActionError,
  ThreadActorError,
  ThreadActorForkError,
  ThreadActorForkErrorReason,
  ThreadActorSnapshot,
  ThreadActorState,
  ThreadIdPayload,
  VerifiedUserIdentity,
  applyEventToState,
  emptyState,
  snapshotFromState,
  stateFromEvents,
} from "./thread-actor"

const identityUserId = (identity: VerifiedUserIdentity | undefined) => identity?.user_id

interface EventRow extends Record<string, unknown> {
  readonly payload: string
}

interface SequenceRow extends Record<string, unknown> {
  readonly sequence: number | null
}

export const actorEventDb = rivetDb({
  onMigrate: async (database) => {
    await database.execute(`
      create table if not exists thread_events (
        id text primary key,
        thread_id text not null,
        turn_id text,
        sequence integer not null,
        version integer not null,
        type text not null,
        payload text not null,
        created_at integer not null
      )
    `)
    await database.execute(
      "create unique index if not exists thread_events_thread_sequence on thread_events(thread_id, sequence)",
    )
    await database.execute(
      "create index if not exists thread_events_thread_created on thread_events(thread_id, created_at)",
    )
  },
})

export const layer: Layer.Layer<
  never,
  never,
  AgentLoop.Service | IdGenerator.Service | Registry.Registry | Time.Service | WorkspaceAccess.Service
> = ThreadActor.toLayer(
  Effect.fnUntraced(function* ({ state, rawRivetkitContext }) {
    const idGenerator = yield* IdGenerator.Service
    const time = yield* Time.Service
    const workspaceAccess = yield* WorkspaceAccess.Service
    const agentLoop = yield* AgentLoop.Service
    const redactor = Option.getOrUndefined(yield* Effect.serviceOption(SecretRedactor.Service))
    const database = rawRivetkitContext.db
    const mutationLock = yield* Semaphore.make(1)
    let turnFiber: { readonly token: symbol; readonly fiber: Fiber.Fiber<void, ThreadActorError> } | undefined

    const readEvents = (input: GetEventsPayload) =>
      Effect.gen(function* () {
        yield* requireActorAccess(workspaceAccess, database, input, "read")
        return yield* readActorEvents(database, input.thread_id, input.after_sequence ?? 0)
      })

    const replay = (input: ThreadIdPayload) =>
      Effect.gen(function* () {
        const events = yield* readActorEvents(database, input.thread_id, 0)
        const hot = yield* State.get(state).pipe(Effect.orDie)
        if (events.length > 0) {
          yield* requireActorAccess(workspaceAccess, database, input, "read")
        } else if (activeSnapshotFromState(hot, input.thread_id) !== undefined) {
          yield* requireHotActorAccess(workspaceAccess, input, hot, "read")
        }
        const next = mergeReplayWithHotState(hot, stateFromEvents(input.thread_id, events), input.thread_id)
        yield* State.set(state, next).pipe(Effect.orDie)
        return snapshotFromState(next, input.thread_id)
      })

    const appendMirroredEventsUnsafe = (input: AppendMirroredEventsPayload) =>
      Effect.gen(function* () {
        if (input.events.length === 0) return { inserted_events: [], skipped_count: 0 }
        const hot = yield* State.get(state).pipe(Effect.orDie)
        const existing = yield* readActorEvents(database, input.thread_id, 0)
        const redactedEvents = input.events.map((event) => ThreadEventLog.redactEvent(redactor, event))
        if (existing.length > 0) {
          yield* requireActorAccess(workspaceAccess, database, input, "write")
        } else {
          const created = redactedEvents[0]
          if (created?.type !== "thread.created") {
            return yield* new ThreadActorActionError({
              message: `AppendMirroredEvents for ${input.thread_id} must start with thread.created`,
              operation: "AppendMirroredEvents",
              thread_id: input.thread_id,
            })
          }
          const userId = identityUserId(input.identity)
          if (userId !== undefined) {
            yield* workspaceAccess.ensureWorkspaceForCreate({
              workspace_id: created.data.workspace_id,
              user_id: userId,
              action: "write",
            })
          }
        }
        let stagedEvents = existing
        const stagedInserted: Array<Event.Event> = []
        let skippedCount = 0
        for (const event of redactedEvents) {
          const validation = validateMirroredEvent(input.thread_id, event)
          if (validation !== undefined) {
            return yield* new ThreadActorActionError({
              message: validation,
              operation: "AppendMirroredEvents",
              thread_id: input.thread_id,
            })
          }
          const existingBySequence = stagedEvents.find((current) => current.sequence === event.sequence)
          if (existingBySequence !== undefined) {
            yield* requireMatchingMirroredEvent(existingBySequence, event, input.thread_id)
            skippedCount += 1
            continue
          }
          const existingById = stagedEvents.find((current) => current.id === event.id)
          if (existingById !== undefined) {
            yield* requireMatchingMirroredEvent(existingById, event, input.thread_id)
            skippedCount += 1
            continue
          }
          const expectedSequence = (stagedEvents.at(-1)?.sequence ?? 0) + 1
          if (event.sequence !== expectedSequence) {
            return yield* new ThreadActorActionError({
              message: `AppendMirroredEvents for ${input.thread_id} expected sequence ${expectedSequence}, received ${event.sequence}`,
              operation: "AppendMirroredEvents",
              thread_id: input.thread_id,
            })
          }
          stagedEvents = [...stagedEvents, event]
          stagedInserted.push(event)
        }
        const inserted = yield* appendMirroredActorEvents(database, state, rawRivetkitContext, stagedInserted)
        const next = stateFromEvents(input.thread_id, stagedEvents)
        yield* State.set(state, next).pipe(Effect.orDie)
        if (shouldCancelHotTurnAfterMirror(hot, next, input.thread_id)) {
          const fiber = turnFiber
          if (fiber !== undefined) {
            turnFiber = undefined
            yield* Fiber.interrupt(fiber.fiber).pipe(Effect.forkScoped, Effect.asVoid)
          }
        }
        return { inserted_events: inserted, skipped_count: skippedCount }
      })

    const replayAfterTurnFailure = (input: ThreadIdPayload, fallbackAppended: boolean) =>
      Effect.gen(function* () {
        const events = yield* readActorEvents(database, input.thread_id, 0)
        const hot = yield* State.get(state).pipe(Effect.orDie)
        const next = mergeReplayAfterTurnFailure(
          hot,
          stateFromEvents(input.thread_id, events),
          input.thread_id,
          fallbackAppended,
        )
        yield* State.set(state, next).pipe(Effect.orDie)
        return snapshotFromState(next, input.thread_id)
      })

    const append = (event: Event.Event) =>
      appendActorEvent(database, state, rawRivetkitContext, event).pipe(
        Effect.mapError((error) => toActionError(error, "appendActorEvent", event.thread_id)),
      )

    const ensureThreadUnsafe = (input: EnsureThreadPayload) =>
      Effect.gen(function* () {
        const hot = yield* State.get(state).pipe(Effect.orDie)
        const hotActive = activeSnapshotFromState(hot, input.thread_id)
        if (hotActive !== undefined) {
          yield* requireEnsureThreadWorkspace(input, hot.workspace_id)
          yield* requireHotActorAccess(workspaceAccess, input, hot, "read")
          return hotActive
        }
        const events = yield* readActorEvents(database, input.thread_id, 0)
        if (events.length > 0) {
          yield* requireActorAccess(
            workspaceAccess,
            database,
            {
              thread_id: input.thread_id,
              ...(input.identity === undefined ? {} : { identity: input.identity }),
            },
            "read",
          )
          const next = mergeReplayWithHotState(hot, stateFromEvents(input.thread_id, events), input.thread_id)
          yield* State.set(state, next).pipe(Effect.orDie)
          yield* requireEnsureThreadWorkspace(input, next.workspace_id)
          return snapshotFromState(next, input.thread_id)
        }
        const userId = identityUserId(input.identity)
        if (userId !== undefined) {
          yield* workspaceAccess.ensureWorkspaceForCreate({
            workspace_id: input.workspace_id,
            user_id: userId,
            action: "write",
          })
        }
        const event = yield* makeThreadCreated(input, idGenerator, time)
        const appended = yield* append(event)
        return snapshotFromState(stateFromEvents(input.thread_id, [appended]), input.thread_id)
      })

    const startTurnUnsafe = (input: StartTurnPayload) =>
      Effect.gen(function* () {
        const hot = yield* State.get(state).pipe(Effect.orDie)
        const hotActive = activeTurnFromState(hot)
        if (hotActive !== undefined) {
          yield* requireHotActorAccess(workspaceAccess, input, hot, "write")
          return yield* hotActive
        }
        const events = yield* readActorEvents(database, input.thread_id, 0)
        let durableEvents: ReadonlyArray<Event.Event> = events
        if (durableEvents.length === 0) {
          const userId = identityUserId(input.identity)
          if (userId !== undefined) {
            yield* workspaceAccess.ensureWorkspaceForCreate({
              workspace_id: input.workspace_id,
              user_id: userId,
              action: "write",
            })
          }
          const created = yield* append(yield* makeThreadCreated(input, idGenerator, time))
          durableEvents = [created]
        }
        const current = stateFromEvents(input.thread_id, durableEvents)
        yield* State.set(state, current).pipe(Effect.orDie)
        if (events.length > 0) {
          yield* requireActorAccess(workspaceAccess, database, input, "write")
        }
        const durableActive = activeTurnFromState(current)
        if (durableActive !== undefined) return yield* durableActive
        const activeState: ThreadActorState = {
          ...current,
          workspace_id: current.workspace_id ?? input.workspace_id,
          ...(current.user_id === undefined && input.identity !== undefined ? { user_id: input.identity.user_id } : {}),
          active_turn_status: "active",
          active_turn_id: undefined,
          ...(input.identity === undefined ? {} : { active_user_id: input.identity.user_id }),
        }
        yield* State.set(state, activeState).pipe(Effect.orDie)
        const turnEvents: Array<Event.Event> = Array.from(durableEvents)
        const appendTracked = (event: Event.Event) =>
          mutationLock.withPermit(
            append(event).pipe(
              Effect.tap((appended) =>
                Effect.sync(() => {
                  turnEvents.push(appended)
                }),
              ),
            ),
          )
        const token = Symbol()
        const fiber = yield* runAgentLoopTurn(input, appendTracked, durableEvents).pipe(
          Effect.catch((error: AgentLoop.RunError | ThreadActorError) =>
            appendFailureIfActive(input, error, turnEvents, appendTracked).pipe(
              Effect.flatMap((fallbackAppended) =>
                mutationLock.withPermit(
                  replayAfterTurnFailure({ thread_id: input.thread_id }, fallbackAppended).pipe(Effect.asVoid),
                ),
              ),
            ),
          ),
          Effect.ensuring(
            mutationLock.withPermit(replay({ thread_id: input.thread_id })).pipe(Effect.catchCause(() => Effect.void)),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (turnFiber?.token === token) turnFiber = undefined
            }),
          ),
          Effect.forkScoped,
        )
        turnFiber = { token, fiber }
        yield* Effect.sync(() => {
          void rawRivetkitContext.keepAwake(Effect.runPromise(Fiber.await(fiber).pipe(Effect.asVoid)))
        })
        return { thread_id: input.thread_id, accepted: true as const }
      })

    const setVisibilityUnsafe = (input: SetVisibilityPayload) =>
      Effect.gen(function* () {
        const hot = yield* State.get(state).pipe(Effect.orDie)
        const events = yield* readActorEvents(database, input.thread_id, 0)
        if (events.length === 0) {
          return yield* new ThreadActorActionError({
            message: `Thread ${input.thread_id} was not found`,
            operation: "SetVisibility",
            thread_id: input.thread_id,
          })
        }
        yield* requireActorAccess(workspaceAccess, database, input, "write")
        const current = stateFromEvents(input.thread_id, events)
        if (current.visibility === input.visibility) {
          const next = mergeReplayWithHotState(hot, current, input.thread_id)
          yield* State.set(state, next).pipe(Effect.orDie)
          return snapshotFromState(next, input.thread_id)
        }
        const appended = yield* append(yield* makeThreadVisibilitySet(input, idGenerator, time))
        const next = mergeReplayWithHotState(
          hot,
          stateFromEvents(input.thread_id, [...events, appended]),
          input.thread_id,
        )
        yield* State.set(state, next).pipe(Effect.orDie)
        return snapshotFromState(next, input.thread_id)
      })

    const setArchivedUnsafe = (input: ThreadIdPayload, archived: boolean) =>
      Effect.gen(function* () {
        const hot = yield* State.get(state).pipe(Effect.orDie)
        const events = yield* readActorEvents(database, input.thread_id, 0)
        if (events.length === 0) {
          return yield* new ThreadActorActionError({
            message: `Thread ${input.thread_id} was not found`,
            operation: archived ? "ArchiveThread" : "UnarchiveThread",
            thread_id: input.thread_id,
          })
        }
        yield* requireActorAccess(workspaceAccess, database, input, "write")
        const current = stateFromEvents(input.thread_id, events)
        if (current.archived === archived) {
          const next = mergeReplayWithHotState(hot, current, input.thread_id)
          yield* State.set(state, next).pipe(Effect.orDie)
          return snapshotFromState(next, input.thread_id)
        }
        const appended = yield* append(yield* makeThreadArchived(input, archived, idGenerator, time))
        const next = mergeReplayWithHotState(
          hot,
          stateFromEvents(input.thread_id, [...events, appended]),
          input.thread_id,
        )
        yield* State.set(state, next).pipe(Effect.orDie)
        return snapshotFromState(next, input.thread_id)
      })

    const compactUnsafe = (input: ThreadIdPayload) =>
      Effect.gen(function* () {
        const events = yield* readActorEvents(database, input.thread_id, 0)
        if (events.length === 0) {
          return yield* new ThreadActorActionError({
            message: `Thread ${input.thread_id} was not found`,
            operation: "CompactThread",
            thread_id: input.thread_id,
          })
        }
        yield* requireActorAccess(workspaceAccess, database, input, "write")
        const hot = yield* State.get(state).pipe(Effect.orDie)
        const current = stateFromEvents(input.thread_id, events)
        const next = mergeReplayWithHotState(hot, current, input.thread_id)
        yield* State.set(state, next).pipe(Effect.orDie)
        const active = activeTurnFromState(next)
        if (active !== undefined) return yield* active
        const compaction = Option.getOrUndefined(yield* Effect.serviceOption(CompactionService.Service))
        if (compaction === undefined) {
          return yield* new ThreadActorActionError({
            message: "Compaction service is unavailable",
            operation: "CompactThread",
            thread_id: input.thread_id,
          })
        }
        yield* hydrateServiceLogFromActorEvents(events)
        const result = yield* compaction
          .planCompact({ thread_id: input.thread_id, trigger: "manual" })
          .pipe(Effect.mapError((error) => toActionError(error, "CompactThread", input.thread_id)))
        const appended = yield* append(result.event)
        if (appended.type !== "context.compacted") {
          return yield* new ThreadActorActionError({
            message: `Expected context.compacted event, received ${appended.type}`,
            operation: "CompactThread",
            thread_id: input.thread_id,
          })
        }
        return appended
      })

    const interruptTurnUnsafe = (input: InterruptTurnPayload) =>
      Effect.gen(function* () {
        const events = yield* readActorEvents(database, input.thread_id, 0)
        if (events.length === 0) {
          return yield* new ThreadActorActionError({
            message: `Thread ${input.thread_id} was not found`,
            operation: "InterruptTurn",
            thread_id: input.thread_id,
          })
        }
        yield* requireActorAccess(workspaceAccess, database, input, "write")
        const terminal = terminalForTurn(events, input.turn_id)
        if (terminal !== undefined) return terminal
        const hot = yield* State.get(state).pipe(Effect.orDie)
        const current = stateFromEvents(input.thread_id, events)
        const next = mergeReplayWithHotState(hot, current, input.thread_id)
        yield* State.set(state, next).pipe(Effect.orDie)
        if (next.active_turn_status === "active") {
          if (next.active_turn_id === undefined || next.active_turn_id !== input.turn_id) {
            return yield* new ThreadActorActiveTurn({
              message:
                next.active_turn_id === undefined
                  ? `Thread ${input.thread_id} has an active turn that has not started yet`
                  : `Thread ${input.thread_id} has active turn ${next.active_turn_id}, not ${input.turn_id}`,
              thread_id: input.thread_id,
              ...(next.active_user_id === undefined ? {} : { active_user_id: next.active_user_id }),
            })
          }
          const fiber = turnFiber
          if (fiber !== undefined) {
            turnFiber = undefined
            yield* Fiber.interrupt(fiber.fiber).pipe(Effect.forkScoped, Effect.asVoid)
          }
        }
        yield* hydrateServiceLogFromActorEvents(events)
        const cancelled = yield* agentLoop
          .cancelTurn({
            thread_id: input.thread_id,
            turn_id: input.turn_id,
            ...(input.identity === undefined ? {} : { user_id: input.identity.user_id }),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          })
          .pipe(Effect.mapError((error) => toActionError(error, "InterruptTurn", input.thread_id)))
        if (cancelled.status === "existing") return cancelled.event
        const appended = yield* append(cancelled.event)
        if (!isTurnTerminal(appended)) {
          return yield* new ThreadActorActionError({
            message: `Expected turn terminal event, received ${appended.type}`,
            operation: "InterruptTurn",
            thread_id: input.thread_id,
          })
        }
        const replayed = stateFromEvents(input.thread_id, [...events, appended])
        yield* State.set(state, replayed).pipe(Effect.orDie)
        return appended
      })

    const prepareForkUnsafe = (input: PrepareForkThreadPayload) =>
      Effect.gen(function* () {
        const events = yield* readActorEvents(database, input.thread_id, 0)
        if (events.length === 0) return yield* forkError(input.thread_id, "source_missing")
        yield* requireActorAccess(workspaceAccess, database, input, "write")
        const hot = yield* State.get(state).pipe(Effect.orDie)
        const current = stateFromEvents(input.thread_id, events)
        const next = mergeReplayWithHotState(hot, current, input.thread_id)
        yield* State.set(state, next).pipe(Effect.orDie)
        if (input.at_turn === undefined && next.active_turn_status === "active") {
          return yield* forkError(input.thread_id, "turn_open", next.active_turn_id)
        }
        const cutoff = yield* forkCutoff(
          events,
          input.thread_id,
          input.at_turn,
          next.active_turn_status === "active" ? next.active_turn_id : undefined,
        )
        const sourcePrefix = events.filter((event) => event.sequence <= cutoff)
        const forkedPrefix = sourcePrefix.filter((event) => event.type !== "thread.visibility.set")
        const created = yield* requireThreadCreated(sourcePrefix, input.thread_id)
        return yield* Effect.forEach(forkedPrefix, (event, index) =>
          forkEvent(idGenerator, {
            event,
            sequence: index + 1,
            forkThreadId: input.fork_thread_id,
            sourceThreadId: input.thread_id,
            sourceCreated: created,
            ...(input.user_id === undefined ? {} : { userId: input.user_id }),
            ...(input.title_text === undefined ? {} : { titleText: input.title_text }),
            cutoff,
          }),
        )
      })

    const importForkUnsafe = (input: ImportForkThreadPayload) =>
      Effect.gen(function* () {
        const existing = yield* readActorEvents(database, input.thread_id, 0)
        if (existing.length > 0) {
          return yield* new ThreadActorActionError({
            message: `Thread ${input.thread_id} already exists`,
            operation: "ImportForkThread",
            thread_id: input.thread_id,
          })
        }
        const validation = validateForkImport(input)
        if (validation !== undefined) {
          return yield* new ThreadActorActionError({
            message: validation,
            operation: "ImportForkThread",
            thread_id: input.thread_id,
          })
        }
        const created = input.events[0]
        if (created?.type !== "thread.created") {
          return yield* new ThreadActorActionError({
            message: `Fork import for ${input.thread_id} must start with thread.created`,
            operation: "ImportForkThread",
            thread_id: input.thread_id,
          })
        }
        yield* workspaceAccess.ensureWorkspaceForCreate({
          workspace_id: created.data.workspace_id,
          user_id: input.identity.user_id,
          action: "write",
        })
        yield* Effect.forEach(input.events, append, { discard: true })
        const imported = yield* readActorEvents(database, input.thread_id, 0)
        const next = stateFromEvents(input.thread_id, imported)
        yield* State.set(state, next).pipe(Effect.orDie)
        return snapshotFromState(next, input.thread_id)
      })

    const readEventsLocked = (input: GetEventsPayload) => mutationLock.withPermit(readEvents(input))
    const ensureThread = (input: EnsureThreadPayload) => mutationLock.withPermit(ensureThreadUnsafe(input))
    const appendMirroredEvents = (input: AppendMirroredEventsPayload) =>
      mutationLock.withPermit(appendMirroredEventsUnsafe(input))
    const replayThread = (input: ThreadIdPayload) => mutationLock.withPermit(replay(input))
    const startTurn = (input: StartTurnPayload) => mutationLock.withPermit(startTurnUnsafe(input))
    const setVisibility = (input: SetVisibilityPayload) => mutationLock.withPermit(setVisibilityUnsafe(input))
    const prepareForkThread = (input: PrepareForkThreadPayload) => mutationLock.withPermit(prepareForkUnsafe(input))
    const importForkThread = (input: ImportForkThreadPayload) => mutationLock.withPermit(importForkUnsafe(input))
    const archiveThread = (input: ThreadIdPayload) => mutationLock.withPermit(setArchivedUnsafe(input, true))
    const unarchiveThread = (input: ThreadIdPayload) => mutationLock.withPermit(setArchivedUnsafe(input, false))
    const compactThread = (input: ThreadIdPayload) => mutationLock.withPermit(compactUnsafe(input))
    const interruptTurn = (input: InterruptTurnPayload) => mutationLock.withPermit(interruptTurnUnsafe(input))

    return ThreadActor.of({
      EnsureThread: ({ payload }) =>
        ensureThread(payload).pipe(Effect.mapError((cause) => toActionError(cause, "EnsureThread", payload.thread_id))),
      StartTurn: ({ payload }) =>
        startTurn(payload).pipe(Effect.mapError((cause) => toActionError(cause, "StartTurn", payload.thread_id))),
      GetEvents: ({ payload }) =>
        readEventsLocked(payload).pipe(
          Effect.mapError((cause) => toActionError(cause, "GetEvents", payload.thread_id)),
        ),
      AppendMirroredEvents: ({ payload }) =>
        appendMirroredEvents(payload).pipe(
          Effect.mapError((cause) => toActionError(cause, "AppendMirroredEvents", payload.thread_id)),
        ),
      ReplayThread: ({ payload }) =>
        replayThread(payload).pipe(Effect.mapError((cause) => toActionError(cause, "ReplayThread", payload.thread_id))),
      GetSnapshot: ({ payload }) =>
        replayThread(payload).pipe(Effect.mapError((cause) => toActionError(cause, "GetSnapshot", payload.thread_id))),
      SetVisibility: ({ payload }) =>
        setVisibility(payload).pipe(
          Effect.mapError((cause) => toActionError(cause, "SetVisibility", payload.thread_id)),
        ),
      PrepareForkThread: ({ payload }) =>
        prepareForkThread(payload).pipe(
          Effect.mapError((cause) => toActionError(cause, "PrepareForkThread", payload.thread_id)),
        ),
      ImportForkThread: ({ payload }) =>
        importForkThread(payload).pipe(
          Effect.mapError((cause) => toActionError(cause, "ImportForkThread", payload.thread_id)),
        ),
      ArchiveThread: ({ payload }) =>
        archiveThread(payload).pipe(
          Effect.mapError((cause) => toActionError(cause, "ArchiveThread", payload.thread_id)),
        ),
      UnarchiveThread: ({ payload }) =>
        unarchiveThread(payload).pipe(
          Effect.mapError((cause) => toActionError(cause, "UnarchiveThread", payload.thread_id)),
        ),
      CompactThread: ({ payload }) =>
        compactThread(payload).pipe(
          Effect.mapError((cause) => toActionError(cause, "CompactThread", payload.thread_id)),
        ),
      InterruptTurn: ({ payload }) =>
        interruptTurn(payload).pipe(
          Effect.mapError((cause) => toActionError(cause, "InterruptTurn", payload.thread_id)),
        ),
    })
  }),
  {
    state: {
      schema: ThreadActorState,
      initialValue: emptyState,
    },
    db: actorEventDb,
    name: "Rika Thread Actor",
    icon: "comments",
  },
)

const readActorEvents = (
  database: RawAccess,
  threadId: Ids.ThreadId,
  afterSequence: number,
): Effect.Effect<ReadonlyArray<Event.Event>, ThreadActorActionError> =>
  Effect.tryPromise({
    try: async () => {
      const rows = await database.execute<EventRow>(
        "select payload from thread_events where thread_id = ? and sequence > ? order by sequence asc",
        threadId,
        afterSequence,
      )
      return rows.map((row) => ThreadEventLog.decodePayload(row.payload))
    },
    catch: (cause) =>
      new ThreadActorActionError({
        message: cause instanceof Error ? cause.message : String(cause),
        operation: "readActorEvents",
        thread_id: threadId,
      }),
  })

const requireEnsureThreadWorkspace = (
  input: EnsureThreadPayload,
  existingWorkspaceId: Ids.WorkspaceId | undefined,
): Effect.Effect<void, ThreadActorActionError> =>
  existingWorkspaceId === undefined || existingWorkspaceId === input.workspace_id
    ? Effect.void
    : Effect.fail(
        new ThreadActorActionError({
          message: `Thread ${input.thread_id} already belongs to another workspace`,
          operation: "EnsureThread",
          thread_id: input.thread_id,
        }),
      )

const latestActorSequence = (
  database: RawAccess,
  threadId: Ids.ThreadId,
): Effect.Effect<number, ThreadActorActionError> =>
  Effect.tryPromise({
    try: async () => {
      const rows = await database.execute<SequenceRow>(
        "select max(sequence) as sequence from thread_events where thread_id = ?",
        threadId,
      )
      return rows[0]?.sequence ?? 0
    },
    catch: (cause) =>
      new ThreadActorActionError({
        message: cause instanceof Error ? cause.message : String(cause),
        operation: "latestActorSequence",
        thread_id: threadId,
      }),
  })

const appendActorEvent = (
  database: RawAccess,
  state: State.State<ThreadActorState, Schema.SchemaError>,
  context: { readonly broadcast: (name: string, ...args: ReadonlyArray<unknown>) => void },
  input: Event.Event,
): Effect.Effect<Event.Event, ThreadActorActionError> =>
  Effect.gen(function* () {
    const sequence = (yield* latestActorSequence(database, input.thread_id)) + 1
    const event = { ...input, sequence } as Event.Event
    yield* Effect.tryPromise({
      try: () =>
        database.execute(
          `insert into thread_events (
            id,
            thread_id,
            turn_id,
            sequence,
            version,
            type,
            payload,
            created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
          event.id,
          event.thread_id,
          event.turn_id ?? null,
          event.sequence,
          event.version,
          event.type,
          ThreadEventLog.encodePayload(event),
          event.created_at,
        ),
      catch: (cause) =>
        new ThreadActorActionError({
          message: cause instanceof Error ? cause.message : String(cause),
          operation: "appendActorEvent",
          thread_id: event.thread_id,
        }),
    })
    yield* State.update(state, (current) => applyEventToState(current, event)).pipe(Effect.orDie)
    yield* Effect.sync(() => context.broadcast("threadEvent", Codec.encode(Event.Event)(event)))
    return event
  })

const appendMirroredActorEvents = (
  database: RawAccess,
  state: State.State<ThreadActorState, Schema.SchemaError>,
  context: { readonly broadcast: (name: string, ...args: ReadonlyArray<unknown>) => void },
  events: ReadonlyArray<Event.Event>,
): Effect.Effect<ReadonlyArray<Event.Event>, ThreadActorActionError> =>
  Effect.gen(function* () {
    if (events.length === 0) return []
    let committed = false
    yield* Effect.tryPromise({
      try: async () => {
        await database.execute("begin immediate")
        try {
          for (const event of events) {
            await database.execute(
              `insert into thread_events (
                id,
                thread_id,
                turn_id,
                sequence,
                version,
                type,
                payload,
                created_at
              ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
              event.id,
              event.thread_id,
              event.turn_id ?? null,
              event.sequence,
              event.version,
              event.type,
              ThreadEventLog.encodePayload(event),
              event.created_at,
            )
          }
          await database.execute("commit")
          committed = true
        } finally {
          if (!committed) await database.execute("rollback").catch(() => undefined)
        }
      },
      catch: (cause) =>
        new ThreadActorActionError({
          message: cause instanceof Error ? cause.message : String(cause),
          operation: "appendMirroredActorEvents",
          thread_id: events[0]?.thread_id,
        }),
    })
    for (const event of events) {
      yield* State.update(state, (current) => applyEventToState(current, event)).pipe(Effect.orDie)
      yield* Effect.sync(() => context.broadcast("threadEvent", Codec.encode(Event.Event)(event)))
    }
    return events
  })

const requireActorAccess = (
  workspaceAccess: WorkspaceAccess.Interface,
  database: RawAccess,
  input: ThreadIdPayload,
  action: "read" | "write",
): Effect.Effect<void, ThreadActorActionError | WorkspaceAccess.RunError> =>
  Effect.gen(function* () {
    const identity = input.identity
    if (identity === undefined) return
    const events = yield* readActorEvents(database, input.thread_id, 0)
    const summary = actorSummaryFromEvents(input.thread_id, events)
    if (summary === undefined) {
      if (events.length === 0) return
      yield* new ThreadActorActionError({
        message: `Thread ${input.thread_id} has durable events without workspace ownership facts`,
        operation: "requireActorAccess",
        thread_id: input.thread_id,
      })
      return
    }
    yield* workspaceAccess.requireThreadSummary(summary, {
      thread_id: input.thread_id,
      user_id: identity.user_id,
      action,
    })
  })

const requireHotActorAccess = (
  workspaceAccess: WorkspaceAccess.Interface,
  input: ThreadIdPayload,
  state: ThreadActorState,
  action: "read" | "write",
): Effect.Effect<void, ThreadActorActionError | WorkspaceAccess.RunError> =>
  Effect.gen(function* () {
    const identity = input.identity
    if (identity === undefined) return
    const summary = actorSummaryFromState(input.thread_id, state)
    if (summary === undefined) {
      yield* Effect.fail(
        new ThreadActorActionError({
          message: `Thread ${input.thread_id} has active hot state without workspace ownership facts`,
          operation: "requireHotActorAccess",
          thread_id: input.thread_id,
        }),
      )
    } else {
      yield* workspaceAccess.requireThreadSummary(summary, {
        thread_id: input.thread_id,
        user_id: identity.user_id,
        action,
      })
    }
  })

const actorSummaryFromEvents = (
  threadId: Ids.ThreadId,
  events: ReadonlyArray<Event.Event>,
): ThreadProjection.ThreadSummary | undefined => {
  const created = events.find((event): event is Event.ThreadCreated => event.type === "thread.created")
  if (created === undefined) return undefined
  const state = stateFromEvents(threadId, events)
  const latest = events.at(-1) ?? created
  const visibility = events.reduce<Event.ThreadVisibility>(
    (current, event) =>
      event.type === "thread.visibility.set" && "visibility" in event.data ? event.data.visibility : current,
    "private",
  )
  const activeTurn =
    state.active_turn_status === "idle"
      ? {}
      : { active_turn_id: state.active_turn_id, active_turn_status: state.active_turn_status }
  return {
    thread_id: threadId,
    workspace_id: created.data.workspace_id,
    ...(created.data.user_id === undefined ? {} : { user_id: created.data.user_id }),
    ...(state.latest_message_id === undefined ? {} : { latest_message_id: state.latest_message_id }),
    ...(state.latest_message_role === undefined ? {} : { latest_message_role: state.latest_message_role }),
    ...(state.latest_message_text === undefined ? {} : { latest_message_text: state.latest_message_text }),
    diff: { additions: 0, modifications: 0, deletions: 0 },
    ...activeTurn,
    archived: state.archived,
    visibility,
    created_at: created.created_at,
    updated_at: latest.created_at,
  }
}

const actorSummaryFromState = (
  threadId: Ids.ThreadId,
  state: ThreadActorState,
): ThreadProjection.ThreadSummary | undefined => {
  if (state.workspace_id === undefined) return undefined
  const activeTurn =
    state.active_turn_status === "idle"
      ? {}
      : { active_turn_id: state.active_turn_id, active_turn_status: state.active_turn_status }
  const createdAt = state.created_at ?? 0
  return {
    thread_id: state.thread_id ?? threadId,
    workspace_id: state.workspace_id,
    ...(state.user_id === undefined ? {} : { user_id: state.user_id }),
    ...(state.latest_message_id === undefined ? {} : { latest_message_id: state.latest_message_id }),
    ...(state.latest_message_role === undefined ? {} : { latest_message_role: state.latest_message_role }),
    ...(state.latest_message_text === undefined ? {} : { latest_message_text: state.latest_message_text }),
    diff: { additions: 0, modifications: 0, deletions: 0 },
    ...activeTurn,
    archived: state.archived,
    visibility: state.visibility,
    created_at: createdAt,
    updated_at: createdAt,
  }
}

const makeThreadCreated = (
  input: EnsureThreadPayload,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
): Effect.Effect<Event.ThreadCreated> =>
  Effect.gen(function* () {
    const userId = input.identity?.user_id
    const createdAt = yield* time.nowMillis
    const eventId = Ids.EventId.make(yield* idGenerator.next("event"))
    return {
      id: eventId,
      thread_id: input.thread_id,
      sequence: 0,
      version: 1,
      created_at: createdAt,
      type: "thread.created",
      data:
        userId === undefined
          ? { workspace_id: input.workspace_id }
          : { workspace_id: input.workspace_id, user_id: userId },
    }
  })

const makeThreadVisibilitySet = (
  input: SetVisibilityPayload,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
): Effect.Effect<Event.ThreadVisibilitySet> =>
  Effect.gen(function* () {
    const createdAt = yield* time.nowMillis
    return {
      id: Ids.EventId.make(yield* idGenerator.next("event")),
      thread_id: input.thread_id,
      sequence: 0,
      version: 1,
      created_at: createdAt,
      type: "thread.visibility.set",
      data: { visibility: input.visibility },
    }
  })

const makeThreadArchived = (
  input: ThreadIdPayload,
  archived: boolean,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
): Effect.Effect<Event.ThreadArchived | Event.ThreadUnarchived> =>
  Effect.gen(function* () {
    const createdAt = yield* time.nowMillis
    const common = {
      id: Ids.EventId.make(yield* idGenerator.next("event")),
      thread_id: input.thread_id,
      sequence: 0,
      version: 1 as const,
      created_at: createdAt,
      data: {},
    }
    return archived ? { ...common, type: "thread.archived" } : { ...common, type: "thread.unarchived" }
  })

interface ForkEventInput {
  readonly event: Event.Event
  readonly sequence: number
  readonly forkThreadId: Ids.ThreadId
  readonly sourceThreadId: Ids.ThreadId
  readonly sourceCreated: Event.ThreadCreated
  readonly userId?: Ids.UserId
  readonly titleText?: string
  readonly cutoff: number
}

const forkEvent = (idGenerator: IdGenerator.Interface, input: ForkEventInput): Effect.Effect<Event.Event> =>
  Effect.gen(function* () {
    const id = Ids.EventId.make(yield* idGenerator.next("event"))
    const fields = {
      id,
      thread_id: input.forkThreadId,
      sequence: input.sequence,
    }
    if (input.event.type === "thread.created") {
      const event: Event.ThreadCreated = {
        ...input.event,
        ...fields,
        data: {
          workspace_id: input.sourceCreated.data.workspace_id,
          ...(input.userId === undefined ? {} : { user_id: input.userId }),
          ...(input.titleText === undefined ? {} : { title_text: input.titleText }),
          forked_from: { thread_id: input.sourceThreadId, sequence: input.cutoff },
        },
      }
      return event
    }
    if (input.event.type === "message.added") {
      const event: Event.MessageAdded = {
        ...input.event,
        ...fields,
        data: {
          message: {
            ...input.event.data.message,
            thread_id: input.forkThreadId,
          },
        },
      }
      return event
    }
    return { ...input.event, ...fields } as Event.Event
  })

const forkCutoff = (
  events: ReadonlyArray<Event.Event>,
  threadId: Ids.ThreadId,
  atTurn: Ids.TurnId | undefined,
  activeTurnId: Ids.TurnId | undefined,
): Effect.Effect<number, ThreadActorForkError> => {
  if (atTurn !== undefined) {
    const terminal = events.find((event) => isTurnTerminal(event) && event.turn_id === atTurn)
    if (terminal !== undefined) return Effect.succeed(terminal.sequence)
    const hasTurn = events.some((event) => event.turn_id === atTurn)
    return hasTurn ? forkError(threadId, "turn_open", atTurn) : forkError(threadId, "turn_missing", atTurn)
  }
  if (activeTurnId !== undefined) return forkError(threadId, "turn_open", activeTurnId)
  const lastStarted = events.findLast((event): event is Event.TurnStarted => event.type === "turn.started")
  if (
    lastStarted !== undefined &&
    !events.some((event) => isTurnTerminal(event) && event.turn_id === lastStarted.turn_id)
  ) {
    return forkError(threadId, "turn_open", lastStarted.turn_id)
  }
  return Effect.succeed(events.at(-1)?.sequence ?? 0)
}

const requireThreadCreated = (
  events: ReadonlyArray<Event.Event>,
  threadId: Ids.ThreadId,
): Effect.Effect<Event.ThreadCreated, ThreadActorForkError> => {
  const created = events.find((event): event is Event.ThreadCreated => event.type === "thread.created")
  if (created !== undefined) return Effect.succeed(created)
  return forkError(threadId, "source_missing")
}

const forkError = (threadId: Ids.ThreadId, reason: ThreadActorForkErrorReason, turnId?: Ids.TurnId) =>
  Effect.fail(
    new ThreadActorForkError({
      message: forkErrorMessage(threadId, reason, turnId),
      reason,
      thread_id: threadId,
      ...(turnId === undefined ? {} : { turn_id: turnId }),
    }),
  )

const forkErrorMessage = (
  threadId: Ids.ThreadId,
  reason: ThreadActorForkErrorReason,
  turnId: Ids.TurnId | undefined,
) => {
  if (reason === "source_missing") return `Thread ${threadId} does not exist`
  if (reason === "turn_missing") return `Thread ${threadId} has no turn ${turnId}`
  if (turnId === undefined) return `Thread ${threadId} has an open turn`
  return `Thread ${threadId} turn ${turnId} is still open`
}

const isTurnTerminal = (event: Event.Event): event is Event.TurnCompleted | Event.TurnFailed =>
  event.type === "turn.completed" || event.type === "turn.failed"

const terminalForTurn = (
  events: ReadonlyArray<Event.Event>,
  turnId: Ids.TurnId,
): Event.TurnCompleted | Event.TurnFailed | undefined =>
  events.findLast(
    (event): event is Event.TurnCompleted | Event.TurnFailed => isTurnTerminal(event) && event.turn_id === turnId,
  )

const shouldCancelHotTurnAfterMirror = (
  hot: ThreadActorState,
  next: ThreadActorState,
  threadId: Ids.ThreadId,
): boolean => {
  if (activeSnapshotFromState(hot, threadId) === undefined) return false
  if (next.active_turn_status === "active") return false
  return next.last_sequence > hot.last_sequence
}

const validateForkImport = (input: ImportForkThreadPayload): string | undefined => {
  if (input.events.length === 0) return `Fork import for ${input.thread_id} has no events`
  const first = input.events[0]
  if (first?.type !== "thread.created") return `Fork import for ${input.thread_id} must start with thread.created`
  if (first.data.forked_from === undefined) return `Fork import for ${input.thread_id} is missing forked_from`
  const createdCount = input.events.filter((event) => event.type === "thread.created").length
  if (createdCount !== 1) return `Fork import for ${input.thread_id} must contain one thread.created event`
  const eventIds = new Set<Ids.EventId>()
  const duplicateId = input.events.find((event) => {
    if (eventIds.has(event.id)) return true
    eventIds.add(event.id)
    return false
  })
  if (duplicateId !== undefined) return `Fork import for ${input.thread_id} has duplicate event ids`
  const invalid = input.events.find((event, index) => {
    if (event.thread_id !== input.thread_id) return true
    if (event.sequence !== index + 1) return true
    if (event.type === "thread.visibility.set") return true
    if (event.type === "message.added" && event.data.message.thread_id !== input.thread_id) return true
    return false
  })
  return invalid === undefined ? undefined : `Fork import for ${input.thread_id} has invalid events`
}

const validateMirroredEvent = (threadId: Ids.ThreadId, event: Event.Event): string | undefined => {
  if (event.thread_id !== threadId)
    return `AppendMirroredEvents for ${threadId} received event ${event.id} for ${event.thread_id}`
  if (event.type === "message.added" && event.data.message.thread_id !== threadId) {
    return `AppendMirroredEvents for ${threadId} received message ${event.data.message.id} for ${event.data.message.thread_id}`
  }
  return undefined
}

const requireMatchingMirroredEvent = (
  existing: Event.Event,
  event: Event.Event,
  threadId: Ids.ThreadId,
): Effect.Effect<void, ThreadActorActionError> =>
  ThreadEventLog.encodePayload(existing) === ThreadEventLog.encodePayload(event)
    ? Effect.void
    : Effect.fail(
        new ThreadActorActionError({
          message: `AppendMirroredEvents for ${threadId} conflicted with existing event ${existing.id}`,
          operation: "AppendMirroredEvents",
          thread_id: threadId,
        }),
      )

export const runAgentLoopTurn: (
  input: StartTurnPayload,
  append: (event: Event.Event) => Effect.Effect<Event.Event, ThreadActorError>,
  existingEvents?: ReadonlyArray<Event.Event>,
) => Effect.Effect<void, AgentLoop.RunError | ThreadActorError, AgentLoop.Service> = Effect.fn(
  "ThreadActor.runAgentLoopTurn",
)(function* (input, append, existingEvents = []) {
  const created = existingEvents.find((event): event is Event.ThreadCreated => event.type === "thread.created")
  const workspaceId = created?.data.workspace_id ?? input.workspace_id
  yield* hydrateServiceLogFromActorEvents(existingEvents)
  yield* AgentLoop.streamTurn({
    thread_id: input.thread_id,
    workspace_id: workspaceId,
    ...(input.identity === undefined ? {} : { user_id: input.identity.user_id }),
    content: input.content,
    ...(input.content_parts === undefined ? {} : { content_parts: input.content_parts }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.fast_mode === undefined ? {} : { fast_mode: input.fast_mode }),
    ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled }),
    ...(input.ide_context === undefined ? {} : { ide_context: input.ide_context }),
    ...(input.tool_access === undefined ? {} : { tool_access: input.tool_access }),
    ...(existingEvents.length === 0 ? {} : { existing_events: existingEvents }),
  }).pipe(Stream.runForEach((event) => append(event).pipe(Effect.asVoid)))
})

const hydrateServiceLogFromActorEvents = (events: ReadonlyArray<Event.Event>) =>
  Effect.gen(function* () {
    if (events.length === 0) return
    const eventLog = yield* Effect.serviceOption(ThreadEventLog.Service)
    const database = yield* Effect.serviceOption(Database.Service)
    if (Option.isSome(eventLog) && Option.isSome(database)) {
      yield* Effect.forEach(events, (event) =>
        eventLog.value.appendIfAbsentAndProject(event).pipe(Effect.provideService(Database.Service, database.value)),
      )
    }
  })

export const activeTurnFromState = (state: ThreadActorState): ThreadActorActiveTurn | undefined => {
  if (state.active_turn_status !== "active" || state.thread_id === undefined) return undefined
  return new ThreadActorActiveTurn({
    message: `Thread ${state.thread_id} already has an active turn`,
    thread_id: state.thread_id,
    ...(state.active_user_id === undefined ? {} : { active_user_id: state.active_user_id }),
  })
}

export const activeSnapshotFromState = (
  state: ThreadActorState,
  threadId: Ids.ThreadId,
): ThreadActorSnapshot | undefined => {
  if (state.active_turn_status !== "active") return undefined
  if ((state.thread_id ?? threadId) !== threadId) return undefined
  return snapshotFromState(state, threadId)
}

export const mergeReplayWithHotState = (
  hot: ThreadActorState,
  replayed: ThreadActorState,
  threadId: Ids.ThreadId,
): ThreadActorState => {
  if (activeSnapshotFromState(hot, threadId) === undefined) return replayed
  if (replayed.active_turn_status === "active") {
    return replayed.active_user_id === undefined &&
      hot.active_user_id !== undefined &&
      (replayed.active_turn_id === undefined || replayed.active_turn_id === hot.active_turn_id)
      ? { ...replayed, active_user_id: hot.active_user_id }
      : replayed
  }
  if (
    replayed.active_turn_status !== "idle" &&
    hot.active_turn_id !== undefined &&
    replayed.active_turn_id === hot.active_turn_id
  ) {
    return replayed
  }
  const { active_turn_id: replayedActiveTurnId, ...replayedWithoutActiveTurnId } = replayed
  void replayedActiveTurnId
  return {
    ...replayedWithoutActiveTurnId,
    thread_id: replayedWithoutActiveTurnId.thread_id ?? hot.thread_id ?? threadId,
    ...(replayedWithoutActiveTurnId.workspace_id === undefined && hot.workspace_id !== undefined
      ? { workspace_id: hot.workspace_id }
      : {}),
    ...(replayedWithoutActiveTurnId.user_id === undefined && hot.user_id !== undefined ? { user_id: hot.user_id } : {}),
    ...(replayedWithoutActiveTurnId.created_at === undefined && hot.created_at !== undefined
      ? { created_at: hot.created_at }
      : {}),
    active_turn_status: "active",
    ...(hot.active_turn_id === undefined ? {} : { active_turn_id: hot.active_turn_id }),
    ...(hot.active_user_id === undefined ? {} : { active_user_id: hot.active_user_id }),
  }
}

export const mergeReplayAfterTurnFailure = (
  hot: ThreadActorState,
  replayed: ThreadActorState,
  threadId: Ids.ThreadId,
  fallbackAppended: boolean,
): ThreadActorState => (fallbackAppended ? mergeReplayWithHotState(hot, replayed, threadId) : replayed)

export const appendFailureIfActive: (
  input: StartTurnPayload,
  error: unknown,
  startingEvents: ReadonlyArray<Event.Event>,
  append: (event: Event.Event) => Effect.Effect<Event.Event, ThreadActorError>,
) => Effect.Effect<boolean, ThreadActorError, IdGenerator.Service | Time.Service> = Effect.fn(
  "ThreadActor.appendFailureIfActive",
)(function* (input, error, startingEvents, append) {
  const started = startingEvents.findLast(
    (event): event is Event.TurnStarted => event.thread_id === input.thread_id && event.type === "turn.started",
  )
  if (started === undefined) return false
  const terminal = startingEvents.findLast(
    (event): event is Event.TurnCompleted | Event.TurnFailed =>
      event.thread_id === input.thread_id &&
      event.turn_id === started.turn_id &&
      (event.type === "turn.completed" || event.type === "turn.failed"),
  )
  if (terminal !== undefined) return false
  const idGenerator = yield* IdGenerator.Service
  const time = yield* Time.Service
  yield* append({
    id: Ids.EventId.make(yield* idGenerator.next("event")),
    thread_id: input.thread_id,
    turn_id: started.turn_id,
    sequence: 0,
    version: 1,
    created_at: yield* time.nowMillis,
    type: "turn.failed",
    data: {
      error: {
        kind: "unknown",
        message: error instanceof Error ? error.message : String(error),
        code: "ThreadActor.streamTurn",
      },
    },
  })
  return true
})

const toActionError = (cause: unknown, operation: string, threadId: Ids.ThreadId): ThreadActorError => {
  if (cause instanceof ThreadActorActionError) return cause
  if (cause instanceof ThreadActorActiveTurn) return cause
  if (cause instanceof ThreadActorForkError) return cause
  if (cause instanceof WorkspaceAccess.WorkspaceAccessError) return cause
  if (cause instanceof WorkspaceAccess.WorkspaceAccessDenied) return cause
  return new ThreadActorActionError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    thread_id: threadId,
  })
}

export const replaySnapshot: (
  threadId: Ids.ThreadId,
  identity?: VerifiedUserIdentity,
) => Effect.Effect<
  ThreadActorSnapshot,
  Database.DatabaseError | ThreadEventLog.ThreadEventLogError | WorkspaceAccess.RunError,
  Database.Service | ThreadEventLog.Service | WorkspaceAccess.Service
> = Effect.fn("ThreadActor.replaySnapshot")(function* (threadId: Ids.ThreadId, identity?: VerifiedUserIdentity) {
  if (identity !== undefined) {
    const workspaceAccess = yield* WorkspaceAccess.Service
    yield* workspaceAccess.requireThread({ thread_id: threadId, user_id: identity.user_id, action: "read" })
  }
  const eventLog = yield* ThreadEventLog.Service
  const events = yield* eventLog.readThread({ thread_id: threadId })
  return snapshotFromState(stateFromEvents(threadId, events), threadId)
})
