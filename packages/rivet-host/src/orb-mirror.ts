import { SecretRedactor } from "@rika/core"
import { OrbActivity, SandboxClient } from "@rika/orb"
import { OrbStore, ProjectStore } from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Event, Ids, Orb } from "@rika/schema"
import { Context, Duration, Effect, FiberMap, Layer, Option, Schedule, Schema, Stream } from "effect"
import * as ThreadClient from "./thread-client"

export class OrbMirrorError extends Schema.TaggedErrorClass<OrbMirrorError>()("OrbMirrorError", {
  message: Schema.String,
  operation: Schema.String,
  orb_id: Schema.optional(Ids.OrbId),
  thread_id: Schema.optional(Ids.ThreadId),
}) {}

export type RunError =
  | Client.SdkError
  | OrbActivity.RunError
  | OrbMirrorError
  | OrbStore.OrbStoreError
  | ProjectStore.ProjectStoreError
  | SandboxClient.RunError
  | ThreadClient.RunError

export type ClientFactory = (endpointUrl: string, token: string) => Client.Interface

export interface Interface {
  readonly mirror: (orbId: Ids.OrbId) => Effect.Effect<void, RunError>
  readonly flush: (orbId: Ids.OrbId) => Effect.Effect<void, RunError>
  readonly mirrorRunningOrbsOnce: () => Effect.Effect<void, RunError>
  readonly syncRunning: () => Effect.Effect<void, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/rivet-host/OrbMirror") {}

const reconnectSchedule = Schedule.exponential("1 second", 2).pipe(
  Schedule.modifyDelay((_output, delay) => Effect.succeed(Duration.min(delay, Duration.seconds(30)))),
  Schedule.collectWhile((metadata) => metadata.input instanceof Client.SdkError),
)

export const layerWithClientFactory = (clientFactory: ClientFactory) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const orbs = yield* OrbStore.Service
      const sandbox = yield* SandboxClient.Service
      const activity = yield* OrbActivity.Service
      const threadClient = yield* ThreadClient.Service
      const projects = Option.getOrUndefined(yield* Effect.serviceOption(ProjectStore.Service))
      const redactor = Option.getOrUndefined(yield* Effect.serviceOption(SecretRedactor.Service))
      const fibers = yield* FiberMap.make<Ids.OrbId, void, RunError>()
      const latestSequence = (threadId: Ids.ThreadId) =>
        threadClient
          .getEvents({ thread_id: threadId, after_sequence: 0 })
          .pipe(Effect.map((events) => events.at(-1)?.sequence ?? 0))
      const appendOrbEvent = Effect.fn("RivetOrbMirror.appendOrbEvent")(function* (
        orb: Orb.OrbRecord,
        event: Event.Event,
      ) {
        if (event.thread_id !== orb.thread_id) {
          return yield* new OrbMirrorError({
            message: `Orb ${orb.orb_id} emitted event ${event.id} for thread ${event.thread_id}`,
            operation: "append",
            orb_id: orb.orb_id,
            thread_id: orb.thread_id,
          })
        }
        const result = yield* threadClient.appendMirroredEvents({ thread_id: event.thread_id, events: [event] })
        if (result.inserted_events.length > 0) yield* activity.touch(orb.orb_id)
        return yield* Effect.void
      })
      const interruptActiveTurn = (threadId: Ids.ThreadId) =>
        threadClient.getEvents({ thread_id: threadId, after_sequence: 0 }).pipe(
          Effect.flatMap((events) => {
            const turnId = latestOpenTurnId(events)
            return turnId === undefined
              ? Effect.void
              : threadClient
                  .interruptTurn({
                    thread_id: threadId,
                    turn_id: turnId,
                    reason: "turn interrupted by orb pause",
                  })
                  .pipe(Effect.asVoid)
          }),
        )
      const mirrorOrbOnce = Effect.fn("RivetOrbMirror.mirrorOrbOnce")(function* (orb: Orb.OrbRecord) {
        const endpoint = yield* orbs.endpointCredentials(orb.orb_id)
        if (endpoint === undefined) {
          return yield* new OrbMirrorError({
            message: `Orb ${orb.orb_id} has no endpoint`,
            operation: "endpoint",
            orb_id: orb.orb_id,
            thread_id: orb.thread_id,
          })
        }
        yield* registerOrbSecrets(projects, redactor, orb, endpoint.token)
        const client = clientFactory(endpoint.endpoint_url, endpoint.token)
        const runAttempt = latestSequence(orb.thread_id).pipe(
          Effect.flatMap((afterSequence) =>
            client
              .subscribeThreadEvents({ thread_id: orb.thread_id, after_sequence: afterSequence })
              .pipe(Stream.runForEach((event) => appendOrbEvent(orb, event))),
          ),
        )
        return yield* runAttempt.pipe(
          Effect.catchTag("SdkError", (error) => handleStreamFailure(orbs, sandbox, orb, error, interruptActiveTurn)),
          Effect.retry(reconnectSchedule),
        )
      })
      const mirror = Effect.fn("RivetOrbMirror.mirror")(function* (orbId: Ids.OrbId) {
        const orb = yield* orbs.get(orbId)
        if (orb === undefined || orb.status !== "running") return
        yield* FiberMap.run(fibers, orbId, { onlyIfMissing: true })(mirrorOrbOnce(orb))
      })
      const flushOrbOnce = Effect.fn("RivetOrbMirror.flushOrbOnce")(function* (orb: Orb.OrbRecord) {
        const endpoint = yield* orbs.endpointCredentials(orb.orb_id)
        if (endpoint === undefined) {
          return yield* new OrbMirrorError({
            message: `Orb ${orb.orb_id} has no endpoint`,
            operation: "endpoint",
            orb_id: orb.orb_id,
            thread_id: orb.thread_id,
          })
        }
        yield* registerOrbSecrets(projects, redactor, orb, endpoint.token)
        const client = clientFactory(endpoint.endpoint_url, endpoint.token)
        yield* latestSequence(orb.thread_id).pipe(
          Effect.flatMap((afterSequence) =>
            client
              .subscribeThreadEvents({ thread_id: orb.thread_id, after_sequence: afterSequence })
              .pipe(Stream.runForEach((event) => appendOrbEvent(orb, event))),
          ),
          Effect.timeoutOption("2 seconds"),
        )
        return yield* Effect.void
      })
      const flush = Effect.fn("RivetOrbMirror.flush")(function* (orbId: Ids.OrbId) {
        const orb = yield* orbs.get(orbId)
        if (orb === undefined || orb.status === "killed") return
        yield* flushOrbOnce(orb)
      })
      const syncRunning = Effect.fn("RivetOrbMirror.syncRunning")(function* () {
        const running = yield* orbs.list({ status: "running" })
        yield* Effect.forEach(running, (orb) => mirror(orb.orb_id), { concurrency: "unbounded", discard: true })
      })

      return Service.of({
        mirror,
        flush,
        mirrorRunningOrbsOnce: Effect.fn("RivetOrbMirror.mirrorRunningOrbsOnce")(function* () {
          const running = yield* orbs.list({ status: "running" })
          yield* Effect.forEach(running, mirrorOrbOnce, { concurrency: "unbounded", discard: true })
        }),
        syncRunning,
      })
    }),
  )

const registerOrbSecrets = Effect.fn("RivetOrbMirror.registerOrbSecrets")(function* (
  projects: ProjectStore.Interface | undefined,
  redactor: SecretRedactor.Interface | undefined,
  orb: Orb.OrbRecord,
  token: string,
) {
  if (redactor === undefined) return
  const entries: Array<SecretRedactor.Entry> = [{ label: "RIKA_ORB_TOKEN", value: token }]
  if (projects !== undefined) {
    const project = yield* projects.get(orb.project_id)
    if (project !== undefined) {
      const secrets = yield* projects.secretsForProvision(orb.project_id)
      entries.push(...SecretRedactor.entriesFromEnv(project.env))
      entries.push(...Object.entries(secrets).map(([label, value]) => ({ label, value })))
    }
  }
  yield* redactor.register(entries)
})

const handleStreamFailure = Effect.fn("RivetOrbMirror.handleStreamFailure")(function* (
  orbs: OrbStore.Interface,
  sandbox: SandboxClient.Interface,
  orb: Orb.OrbRecord,
  error: Client.SdkError,
  interruptActiveTurn: (threadId: Ids.ThreadId) => Effect.Effect<void, RunError>,
) {
  const lifecycle = yield* inspectSandbox(sandbox, orb)
  if (lifecycle === "running") return yield* Effect.fail(error)
  yield* interruptActiveTurn(orb.thread_id)
  return yield* setLifecycleStatus(orbs, orb, lifecycle)
})

const inspectSandbox = Effect.fn("RivetOrbMirror.inspectSandbox")(function* (
  sandbox: SandboxClient.Interface,
  orb: Orb.OrbRecord,
) {
  if (orb.sandbox_id === null) return "running" as const
  const sandboxes = yield* sandbox.list({
    metadata: {
      thread_id: orb.thread_id,
      project_id: orb.project_id,
    },
  })
  const current = sandboxes.find((summary) => summary.sandboxId === orb.sandbox_id)
  if (current === undefined) return "killed" as const
  return current.state
})

const setLifecycleStatus = Effect.fn("RivetOrbMirror.setLifecycleStatus")(function* (
  orbs: OrbStore.Interface,
  orb: Orb.OrbRecord,
  status: "paused" | "killed",
) {
  yield* orbs
    .setStatus(orb.orb_id, status)
    .pipe(
      Effect.catch((error) =>
        error instanceof OrbStore.OrbStoreError && error.reason === "invalid_transition"
          ? Effect.void
          : Effect.fail(error),
      ),
    )
})

const latestOpenTurnId = (events: ReadonlyArray<Event.Event>): Ids.TurnId | undefined => {
  const started = events.findLast((event): event is Event.TurnStarted => event.type === "turn.started")
  if (started === undefined) return undefined
  const terminal = events.findLast(
    (event): event is Event.TurnCompleted | Event.TurnFailed =>
      (event.type === "turn.completed" || event.type === "turn.failed") && event.turn_id === started.turn_id,
  )
  return terminal === undefined ? started.turn_id : undefined
}

export const layer = layerWithClientFactory((endpointUrl, token) =>
  Client.make(Client.fetchTransport({ base_url: endpointUrl, token })),
)

export const mirrorRunningOrbsOnce = Effect.fn("RivetOrbMirror.mirrorRunningOrbsOnce.call")(function* () {
  const service = yield* Service
  return yield* service.mirrorRunningOrbsOnce()
})

export const mirror = Effect.fn("RivetOrbMirror.mirror.call")(function* (orbId: Ids.OrbId) {
  const service = yield* Service
  return yield* service.mirror(orbId)
})

export const flush = Effect.fn("RivetOrbMirror.flush.call")(function* (orbId: Ids.OrbId) {
  const service = yield* Service
  return yield* service.flush(orbId)
})

export const syncRunning = Effect.fn("RivetOrbMirror.syncRunning.call")(function* () {
  const service = yield* Service
  return yield* service.syncRunning()
})
