import { Context, Effect, Layer, Schema } from "effect"
import type { ConfirmOptions, InputOptions, SelectOptions } from "./api"

export class PluginUiError extends Schema.TaggedErrorClass<PluginUiError>()("PluginUiError", {
  message: Schema.String,
  operation: Schema.String,
}) {}

export interface Interface {
  readonly notify: (message: string) => Effect.Effect<void, PluginUiError>
  readonly confirm: (options: ConfirmOptions) => Effect.Effect<boolean, PluginUiError>
  readonly input: (options: InputOptions) => Effect.Effect<string | undefined, PluginUiError>
  readonly select: (options: SelectOptions) => Effect.Effect<string | undefined, PluginUiError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/plugin/PluginUi") {}

export interface MemoryUi {
  readonly notifications: Array<string>
  readonly confirmations: Array<ConfirmOptions>
  readonly inputs: Array<InputOptions>
  readonly selects: Array<SelectOptions>
  readonly confirmResponses: Array<boolean>
  readonly inputResponses: Array<string | undefined>
  readonly selectResponses: Array<string | undefined>
}

export const silentService: Interface = Service.of({
  notify: () => Effect.void,
  confirm: () => Effect.succeed(false),
  input: () => Effect.succeed(undefined),
  select: () => Effect.succeed(undefined),
})

export const silentLayer = Layer.succeed(Service, silentService)

export const memoryLayer = (ui: MemoryUi) =>
  Layer.succeed(
    Service,
    Service.of({
      notify: Effect.fn("PluginUi.notify.memory")(function* (message: string) {
        yield* Effect.sync(() => ui.notifications.push(message))
      }),
      confirm: Effect.fn("PluginUi.confirm.memory")(function* (options: ConfirmOptions) {
        yield* Effect.sync(() => ui.confirmations.push(options))
        return ui.confirmResponses.shift() ?? false
      }),
      input: Effect.fn("PluginUi.input.memory")(function* (options: InputOptions) {
        yield* Effect.sync(() => ui.inputs.push(options))
        return ui.inputResponses.shift()
      }),
      select: Effect.fn("PluginUi.select.memory")(function* (options: SelectOptions) {
        yield* Effect.sync(() => ui.selects.push(options))
        return ui.selectResponses.shift()
      }),
    }),
  )

export const notify = Effect.fn("PluginUi.notify.call")(function* (message: string) {
  const ui = yield* Service
  return yield* ui.notify(message)
})

export const confirm = Effect.fn("PluginUi.confirm.call")(function* (options: ConfirmOptions) {
  const ui = yield* Service
  return yield* ui.confirm(options)
})

export const input = Effect.fn("PluginUi.input.call")(function* (options: InputOptions) {
  const ui = yield* Service
  return yield* ui.input(options)
})

export const select = Effect.fn("PluginUi.select.call")(function* (options: SelectOptions) {
  const ui = yield* Service
  return yield* ui.select(options)
})
