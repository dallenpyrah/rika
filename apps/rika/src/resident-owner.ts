import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Operation, ResidentService } from "@rika/app"
import { FetchHttpClient } from "effect/unstable/http"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"

export const makeResidentOwner =
  <E>(options: {
    readonly operationLayer: (
      interactive: Parameters<ResidentService.Owner>[0],
    ) => Layer.Layer<Operation.Service, E, FileSystem.FileSystem>
    readonly authOperations: Operation.AuthOperationOptions
    readonly cwd: () => string
  }): ResidentService.Owner =>
  (interactive) =>
    Effect.scope.pipe(
      Effect.flatMap((scope) =>
        Effect.gen(function* () {
          const loadProduct = yield* Effect.cached(
            Layer.buildWithScope(
              options
                .operationLayer(interactive)
                .pipe(Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer))),
              scope,
            ).pipe(Effect.map((context) => Context.get(context, Operation.Service))),
          )
          return Operation.Service.of({
            run: (input) =>
              input._tag === "Auth"
                ? Effect.scoped(Operation.runAuth(input, options.authOperations, options.cwd()))
                : loadProduct.pipe(
                    Effect.flatMap((service) => service.run(input)),
                    Effect.mapError((error) =>
                      Schema.is(Operation.OperationUnavailable)(error)
                        ? error
                        : Operation.OperationUnavailable.make({ operation: input._tag, message: String(error) }),
                    ),
                  ),
          })
        }),
      ),
    )
