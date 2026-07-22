import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Operation, ResidentService } from "@rika/app"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as Logging from "./logging"
import * as ResidentProcessStartup from "./resident-process-startup"
import type { makeObservedProgram } from "./process-observation"
import { withClientWorkspace } from "./startup-runtime"
import type { makeClientOwnedInteractive } from "./tui-program"

const provideLayerScoped =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scopedWith((scope) =>
      Effect.context<RIn | Exclude<R, ROut>>().pipe(
        Effect.flatMap((parent) =>
          Layer.buildWithScope(layer, scope).pipe(
            Effect.flatMap((context) => effect.pipe(Effect.provideContext(Context.merge(parent, context)))),
          ),
        ),
      ),
    )

type Environment = Readonly<
  Record<
    | "residentGrace"
    | "residentStartupHold"
    | "testModelResponse"
    | "testModelScript"
    | "testMediaAnalyzerResponse"
    | "testMediaAnalyzerError",
    Option.Option<string>
  >
>

export const clientDispatcherLayer = (options: {
  readonly database: string
  readonly relayDatabase: string
  readonly environment: Environment
  readonly executablePath: string
  readonly cwd: () => string
  readonly interactive: ReturnType<typeof makeClientOwnedInteractive>
  readonly observedProgram: ReturnType<typeof makeObservedProgram>
}) =>
  Layer.effect(
    Operation.Service,
    Effect.gen(function* () {
      const resident = yield* ResidentService.Service
      return Operation.Service.of({
        run: Effect.fn("Operation.dispatch")((input) =>
          Logging.resolveDataRoot(options.database, options.relayDatabase).pipe(
            Effect.flatMap((dataRoot) =>
              options.observedProgram(
                "client",
                dataRoot,
                Effect.scoped(
                  Effect.gen(function* () {
                    const clientInput = withClientWorkspace(input, options.cwd())
                    const value = (name: keyof Environment) => Option.getOrUndefined(options.environment[name])
                    const connected = yield* Effect.result(
                      resident
                        .getOrCreate({
                          profile: "default",
                          dataRoot,
                          clientKind:
                            clientInput._tag === "Interactive"
                              ? "interactive"
                              : clientInput._tag === "Thread"
                                ? "thread-continue"
                                : clientInput._tag === "Run"
                                  ? "run"
                                  : clientInput._tag === "Review"
                                    ? "review"
                                    : clientInput._tag === "Workflow"
                                      ? "workflow"
                                      : "product",
                          startHost: () =>
                            ResidentProcessStartup.spawn({
                              executable: process.execPath,
                              arguments: [options.executablePath],
                              environment: {
                                RIKA_INTERNAL_RESIDENT_HOST: "1",
                                RIKA_INTERNAL_RESIDENT_PROFILE: "default",
                                RIKA_INTERNAL_RESIDENT_DATA_ROOT: dataRoot,
                                ...(value("residentGrace") === undefined
                                  ? {}
                                  : { RIKA_INTERNAL_RESIDENT_GRACE: value("residentGrace")! }),
                                ...(value("residentStartupHold") === undefined
                                  ? {}
                                  : { RIKA_INTERNAL_RESIDENT_STARTUP_HOLD: value("residentStartupHold")! }),
                                ...(value("testModelResponse") === undefined
                                  ? {}
                                  : { RIKA_TEST_MODEL_RESPONSE: value("testModelResponse")! }),
                                ...(value("testModelScript") === undefined
                                  ? {}
                                  : { RIKA_TEST_MODEL_SCRIPT: value("testModelScript")! }),
                                ...(value("testMediaAnalyzerResponse") === undefined
                                  ? {}
                                  : { RIKA_TEST_MEDIA_ANALYZER_RESPONSE: value("testMediaAnalyzerResponse")! }),
                                ...(value("testMediaAnalyzerError") === undefined
                                  ? {}
                                  : { RIKA_TEST_MEDIA_ANALYZER_ERROR: value("testMediaAnalyzerError")! }),
                              },
                            }).pipe(Effect.tap(() => Effect.logInfo("resident.spawned"))),
                        })
                        .pipe(provideLayerScoped(Layer.merge(BunServices.layer, BunCrypto.layer))),
                    )
                    if (connected._tag === "Failure")
                      return yield* Operation.OperationUnavailable.make({
                        operation: clientInput._tag,
                        message: connected.failure.message,
                      })
                    const connection = connected.success
                    yield* Effect.logInfo("resident.connected")
                    yield* connection
                      .run(clientInput, {
                        stdout: (text) => Effect.sync(() => process.stdout.write(text)),
                        stderr: (text) => Effect.sync(() => process.stderr.write(text)),
                        ...(clientInput._tag === "Interactive" ? { interactive: options.interactive } : {}),
                      })
                      .pipe(
                        Effect.mapError((error) =>
                          Schema.is(Operation.OperationUnavailable)(error)
                            ? error
                            : Operation.OperationUnavailable.make({
                                operation: clientInput._tag,
                                message: error.message,
                              }),
                        ),
                        Effect.ensuring(connection.close),
                      )
                  }),
                ).pipe(
                  Effect.tap(() => Effect.logInfo("operation.completed")),
                  Effect.tapError(() => Effect.logError("operation.failed")),
                  Effect.annotateLogs("rika.operation", input._tag),
                ),
              ),
            ),
            provideLayerScoped(BunServices.layer),
            Effect.mapError((error) =>
              Schema.is(Operation.OperationUnavailable)(error)
                ? error
                : Operation.OperationUnavailable.make({ operation: input._tag, message: String(error) }),
            ),
          ),
        ),
      })
    }),
  )
