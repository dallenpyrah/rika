import * as BunServices from "@effect/platform-bun/BunServices"
import { ModelRegistry } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { expect, test } from "vitest"
import { Duration, Effect, Fiber, FileSystem, Layer, Schedule } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { start } from "./current-execution-route"

const provide = <A, E, R, ROut, E2, RIn>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<ROut, E2, RIn>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* Effect.provide(effect, context)
    }),
  )

const runNative = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof BunServices.layer>>) =>
  Effect.runPromise(provide(effect, BunServices.layer))

const withBackend = <A, E>(
  script: Parameters<typeof TestModel.make>[0],
  run: (
    fixture: TestModel.Fixture,
    directory: string,
  ) => Effect.Effect<A, E, ExecutionBackend.Service | FileSystem.FileSystem>,
  options?: Pick<RelayExecutionBackend.LayerOptions, "modelResilience" | "compaction" | "permissionPolicy"> & {
    readonly registration?: (fixture: TestModel.Fixture) => ModelRegistry.Registration
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runtime-" })
      const fixture = yield* TestModel.make(script)
      const { registration, ...layerOptions } = options ?? {}
      return yield* provide(
        run(fixture, directory),
        RelayExecutionBackend.layer({
          filename: `${directory}/relay.db`,
          workspace: directory,
          registration: registration?.(fixture) ?? fixture.registration,
          selection: fixture.selection,
          modelVariantPolicy: "fixed-selection",
          ...layerOptions,
        }),
      )
    }),
  )

test(
  "cancels an in-flight model through Relay",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend(
          [TestModel.turn([TestModel.text("late")], { delay: Duration.seconds(5) })],
          (fixture) =>
            Effect.scoped(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                const fiber = yield* Effect.forkScoped(
                  start(backend, { threadId: "thread-a", turnId: "turn-cancel", prompt: "wait", startedAt: 1 }),
                )
                yield* fixture.awaitRequests(1)
                const accepted = yield* backend.cancel("turn-cancel", 2)
                const completed = yield* Fiber.join(fiber)
                return { accepted, completed }
              }),
            ),
        )
        const result = yield* program
        expect(result.accepted.status).toBe("cancelled")
        expect(result.accepted.events.filter((event) => event.type === "execution.cancelled")).toHaveLength(1)
        expect(result.completed.status).toBe("cancelled")
        expect(result.completed.events.filter((event) => event.type === "execution.cancelled")).toHaveLength(1)
      }),
    ),
  30_000,
)

for (const answer of ["Approved", "Denied", "Always"] as const) {
  test(
    `resumes a durable permission wait after restart with ${answer} and no duplicate tool effects`,
    () =>
      runNative(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem
              const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-permission-" })
              yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "permission fixture")
              const fixture = yield* TestModel.make([
                TestModel.turn([TestModel.toolCall("read", { path: "fixture.txt" }, { id: `read-${answer}` })]),
                TestModel.text(`${answer} complete`),
              ])
              const options = {
                filename: `${directory}/relay.db`,
                workspace: directory,
                registration: fixture.registration,
                selection: fixture.selection,
                modelVariantPolicy: "fixed-selection" as const,
                permissionPolicy: { rules: [{ pattern: "read", level: "ask" as const }] },
              }
              const useBackend = <A, E>(effect: Effect.Effect<A, E, ExecutionBackend.Service>) =>
                provide(effect, RelayExecutionBackend.layer(options))
              const input = {
                threadId: `thread-${answer}`,
                turnId: `turn-${answer}`,
                prompt: "read fixture",
                startedAt: 1,
              }
              const waiting = yield* useBackend(
                Effect.gen(function* () {
                  const backend = yield* ExecutionBackend.Service
                  const started = yield* start(backend, input)
                  const inspection = yield* backend.inspect(input.turnId)
                  return { started, waits: inspection?.waits ?? [] }
                }),
              )
              expect(waiting.started.status).toBe("waiting")
              expect(waiting.waits).toHaveLength(1)
              const waitId = waiting.waits[0]!.id
              const completed = yield* useBackend(
                Effect.gen(function* () {
                  const backend = yield* ExecutionBackend.Service
                  yield* backend.resolvePermission(waitId, answer, 2, "test decision")
                  const resumed = yield* start(backend, input)
                  const duplicate = yield* start(backend, input)
                  const replay = yield* backend.replay(input.turnId)
                  return { resumed, duplicate, replay, approvals: yield* backend.listApprovals(input.turnId) }
                }),
              )
              return { ...completed, requests: yield* fixture.requests }
            }),
          )
          expect(result.resumed.status).toBe(answer === "Denied" ? "failed" : "completed")
          expect(result.duplicate.status).toBe(answer === "Denied" ? "failed" : "completed")
          expect(result.approvals).toEqual([])
          expect(result.requests).toHaveLength(answer === "Denied" ? 1 : 2)
          expect(result.replay.events.filter((event) => event.type === "tool.result.received")).toHaveLength(
            answer === "Denied" ? 0 : 1,
          )
          expect(result.replay.events.map((event) => event.cursor)).toEqual(
            result.duplicate.events.map((event) => event.cursor),
          )
        }),
      ),
    60_000,
  )
}

test(
  "thread host entity wakes on a delivered promotion and invokes the registered promoter",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend([], (_fixture) =>
          Effect.gen(function* () {
            const backend = yield* ExecutionBackend.Service
            const promoted: Array<readonly [string, number]> = []
            yield* backend.registerTurnPromoter!((threadId, generation) =>
              Effect.sync(() => {
                promoted.push([threadId, generation])
                return 1
              }),
            )
            yield* backend.wakeThreadHost!({
              threadId: "thread-host-native",
              generation: 1,
              queueRevision: 1,
              now: 3,
            })
            yield* backend.wakeThreadHost!({
              threadId: "thread-host-native",
              generation: 1,
              queueRevision: 1,
              now: 4,
            })
            yield* Effect.suspend(() =>
              promoted.length > 0
                ? Effect.void
                : Effect.fail(ExecutionBackend.BackendError.make({ message: "promoter not invoked yet" })),
            ).pipe(Effect.retry({ schedule: Schedule.spaced(Duration.millis(100)), times: 100 }))
            return promoted
          }),
        )
        const promoted = yield* program
        expect(promoted).toEqual([["thread-host-native", 1]])
      }),
    ),
  60_000,
)
