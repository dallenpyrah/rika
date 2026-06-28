import { PermissionPolicy, SubagentRuntime, ToolExecutor, ToolRegistry } from "@rika/agent"
import { Config } from "@rika/core"
import { PluginHost } from "@rika/plugin"
import { Effect, Layer } from "effect"
import * as AstGrepOutline from "./ast-grep-outline"
import * as FffSearch from "./fff-search"
import * as HashlineFile from "./hashline-file"
import * as SemanticSearch from "./semantic-search"

export const registryLayerFromServices: Layer.Layer<
  ToolRegistry.Service,
  never,
  | AstGrepOutline.Service
  | Config.Service
  | FffSearch.Service
  | HashlineFile.Service
  | PluginHost.Service
  | SemanticSearch.Service
  | SubagentRuntime.Service
> = Layer.effect(
  ToolRegistry.Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const values = yield* config.get
    const astGrepOutline = yield* AstGrepOutline.Service
    const fffSearch = yield* FffSearch.Service
    const hashlineFile = yield* HashlineFile.Service
    const semanticSearch = yield* SemanticSearch.Service
    const subagentRuntime = yield* SubagentRuntime.Service
    const pluginDefinitions = yield* PluginHost.toolDefinitions()
    const definitions = [
      ...ToolRegistry.shellDefinitions(values.workspace_root),
      ...SubagentRuntime.toolDefinitions(subagentRuntime),
      ...pluginDefinitions,
      ...SemanticSearch.toolDefinitions(semanticSearch),
      ...FffSearch.toolDefinitions(fffSearch),
      ...AstGrepOutline.toolDefinitions(astGrepOutline),
      ...HashlineFile.toolDefinitions(hashlineFile),
    ]

    return yield* ToolRegistry.Service.pipe(Effect.provide(ToolRegistry.layerFromDefinitions(definitions)))
  }),
)

export const readOnlyRegistryLayerFromServices: Layer.Layer<
  ToolRegistry.Service,
  never,
  AstGrepOutline.Service | Config.Service | FffSearch.Service | HashlineFile.Service | SemanticSearch.Service
> = Layer.effect(
  ToolRegistry.Service,
  Effect.gen(function* () {
    const astGrepOutline = yield* AstGrepOutline.Service
    const fffSearch = yield* FffSearch.Service
    const hashlineFile = yield* HashlineFile.Service
    const semanticSearch = yield* SemanticSearch.Service
    const definitions = [
      ...SemanticSearch.toolDefinitions(semanticSearch),
      ...FffSearch.toolDefinitions(fffSearch),
      ...AstGrepOutline.toolDefinitions(astGrepOutline),
      ...HashlineFile.toolDefinitions(hashlineFile),
    ].filter((definition) => SubagentRuntime.readOnlyToolNames.some((name) => name === definition.descriptor.name))

    return yield* ToolRegistry.Service.pipe(Effect.provide(ToolRegistry.layerFromDefinitions(definitions)))
  }),
)

export const registryLayer: Layer.Layer<
  ToolRegistry.Service,
  FffSearch.FffSearchError,
  Config.Service | PluginHost.Service | SubagentRuntime.Service
> = registryLayerFromServices.pipe(
  Layer.provideMerge(SemanticSearch.layer),
  Layer.provideMerge(FffSearch.layer),
  Layer.provideMerge(AstGrepOutline.layer),
  Layer.provideMerge(HashlineFile.layer),
)

export const readOnlyRegistryLayer: Layer.Layer<ToolRegistry.Service, FffSearch.FffSearchError, Config.Service> =
  readOnlyRegistryLayerFromServices.pipe(
    Layer.provideMerge(SemanticSearch.layer),
    Layer.provideMerge(FffSearch.layer),
    Layer.provideMerge(AstGrepOutline.layer),
    Layer.provideMerge(HashlineFile.layer),
  )

export const toolExecutorLayer: Layer.Layer<
  ToolExecutor.Service,
  FffSearch.FffSearchError,
  Config.Service | PluginHost.Service | SubagentRuntime.Service
> = PluginHost.toolResultExecutorLayer.pipe(
  Layer.provideMerge(
    ToolExecutor.layer.pipe(Layer.provideMerge(registryLayer), Layer.provideMerge(PluginHost.permissionPolicyLayer)),
  ),
)

export const readOnlyToolExecutorLayer: Layer.Layer<ToolExecutor.Service, FffSearch.FffSearchError, Config.Service> =
  ToolExecutor.layer.pipe(Layer.provideMerge(readOnlyRegistryLayer), Layer.provideMerge(PermissionPolicy.allowLayer))
