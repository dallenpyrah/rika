import { PermissionPolicy, ToolExecutor, ToolRegistry } from "@rika/agent"
import { Config } from "@rika/core"
import { Effect, Layer } from "effect"
import * as FffSearch from "./fff-search"
import * as HashlineFile from "./hashline-file"

export const registryLayerFromServices: Layer.Layer<
  ToolRegistry.Service,
  never,
  Config.Service | FffSearch.Service | HashlineFile.Service
> = Layer.effect(
  ToolRegistry.Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const values = yield* config.get
    const fffSearch = yield* FffSearch.Service
    const hashlineFile = yield* HashlineFile.Service
    const definitions = [
      ...ToolRegistry.shellDefinitions(values.workspace_root),
      ...FffSearch.toolDefinitions(fffSearch),
      ...HashlineFile.toolDefinitions(hashlineFile),
    ]

    return yield* ToolRegistry.Service.pipe(Effect.provide(ToolRegistry.layerFromDefinitions(definitions)))
  }),
)

export const registryLayer: Layer.Layer<ToolRegistry.Service, FffSearch.FffSearchError, Config.Service> =
  registryLayerFromServices.pipe(Layer.provideMerge(FffSearch.layer), Layer.provideMerge(HashlineFile.layer))

export const toolExecutorLayer: Layer.Layer<ToolExecutor.Service, FffSearch.FffSearchError, Config.Service> =
  ToolExecutor.layer.pipe(Layer.provideMerge(registryLayer), Layer.provideMerge(PermissionPolicy.allowLayer))
