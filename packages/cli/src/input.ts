import { Context, Effect, Layer } from "effect"

export interface Interface {
  readonly readAll: Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Input") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    readAll: Effect.fn("Cli.Input.readAll")(function* () {
      return yield* Effect.promise(() => Bun.stdin.text())
    })(),
  }),
)

export const memoryLayer = (text: string) =>
  Layer.succeed(
    Service,
    Service.of({
      readAll: Effect.succeed(text),
    }),
  )

export const readAll = Effect.fn("Cli.Input.readAll.call")(function* () {
  const input = yield* Service
  return yield* input.readAll
})
