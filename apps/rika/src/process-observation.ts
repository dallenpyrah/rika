import * as BunServices from "@effect/platform-bun/BunServices"
import { ConfigService } from "@rika/config"
import { Cause, Clock, Context, Effect, Layer, References } from "effect"
import { loadSettingsFile } from "./backend-settings"
import * as Logging from "./logging"

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

export const makeObservedProgram =
  (options: {
    readonly globalConfig: string
    readonly workspaceConfig: string
    readonly version: string
    readonly failureKind: (cause: Cause.Cause<unknown>) => string
  }) =>
  <A, E>(role: Logging.ProcessRole, dataRoot: string, program: Effect.Effect<A, E>) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((startedAt) =>
        Effect.logInfo("process.started").pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const globalSettings = yield* loadSettingsFile(options.globalConfig)
              const workspaceSettings = yield* loadSettingsFile(options.workspaceConfig)
              const effectiveConfig = yield* ConfigService.effective().pipe(
                provideLayerScoped(ConfigService.memoryLayer({ global: globalSettings, workspace: workspaceSettings })),
              )
              return yield* program.pipe(
                Effect.provideService(
                  References.MinimumLogLevel,
                  Logging.minimumLevel(effectiveConfig.settings.logging.level),
                ),
              )
            }),
          ),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("process.failed").pipe(
                  Effect.annotateLogs("rika.failure.kind", options.failureKind(cause)),
                ),
          ),
          Effect.ensuring(Effect.logInfo("process.stopped")),
          Effect.annotateLogs({
            "rika.process.role": role,
            "rika.process.instance": `${startedAt}-${process.pid}`,
            "rika.process.pid": process.pid,
            "rika.version": options.version,
          }),
        ),
      ),
      provideLayerScoped(
        Layer.merge(
          Logging.layer({ dataRoot, role, version: options.version }).pipe(Layer.provide(BunServices.layer)),
          BunServices.layer,
        ),
      ),
    )
