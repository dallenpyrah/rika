import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as ProductAgent from "../product-agent"
import { ExecutionExtensions } from "@rika/extensions"
import { ConfigService } from "@rika/config"
import * as ExtensionOperations from "../extension-operations"
import * as OpenAiAuth from "../openai-auth"
import { Runtime as ToolRuntime } from "@rika/tools"
import { Effect, Layer, Schema } from "effect"
import * as ConfigOperations from "../config-operations"
import * as ResolvedContext from "../resolved-context"
import type { Input, InteractiveSession, OperationUnavailable } from "../operation-contract"

export class OperationError extends Schema.TaggedErrorClass<OperationError>()("OperationError", {
  message: Schema.String,
}) {}

export const operationError = (message: string) => OperationError.make({ message })
export interface ProductLayerOptions<
  ThreadError,
  TurnError,
  BackendError,
  ThreadSummaryError = never,
  TranscriptError = never,
> {
  readonly repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadError>
  readonly turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnError>
  readonly threadSummaryRepositoryLayer?: Layer.Layer<ThreadSummaryRepository.Service, ThreadSummaryError>
  readonly transcriptRepositoryLayer?: Layer.Layer<TranscriptRepository.Service, TranscriptError>
  readonly backendLayer: Layer.Layer<ExecutionBackend.Service, BackendError>
  readonly resolveExecutionRoute?: (
    mode: "low" | "medium" | "high" | "ultra",
    tuning?: { readonly fastMode?: boolean },
    workspace?: string,
  ) => Effect.Effect<Turn.ExecutionRoutePin, OperationError, ExecutionBackend.Service>
  readonly productAgentLayer?: Layer.Layer<ProductAgent.Service, OperationError, ExecutionBackend.Service>
  readonly toolRuntimeLayer?: (workspace: string) => Layer.Layer<ToolRuntime.Service, OperationError, never>
  readonly resolvedContextLayer?: Layer.Layer<ResolvedContext.Service, OperationError>
  readonly executionExtensions?: {
    readonly layer: Layer.Layer<ExecutionExtensions.Service, OperationError>
    readonly mcpFingerprint: Effect.Effect<string>
  }
  readonly defaultWorkspace: string
  readonly pendingTurnCapacity?: number
  readonly shellPermission?: "ask" | "allow" | "deny" | ((workspace: string) => Effect.Effect<"ask" | "allow" | "deny">)
  readonly makeThreadId: Effect.Effect<Thread.ThreadId>
  readonly makeTurnId: Effect.Effect<Turn.TurnId>
  readonly configOperations?: {
    readonly layer: Layer.Layer<ConfigOperations.Adapter | ConfigService.Service, OperationError>
    readonly options: ConfigOperations.Options
    readonly forWorkspace?: (workspace: string) => Effect.Effect<
      {
        readonly layer: Layer.Layer<ConfigOperations.Adapter | ConfigService.Service, OperationError>
        readonly options: ConfigOperations.Options
      },
      OperationError
    >
  }
  readonly extensionOperations?: {
    readonly layer: Layer.Layer<
      | ExtensionOperations.Service
      | import("@rika/extensions").McpOAuth.Service
      | import("effect").FileSystem.FileSystem
      | import("effect").Path.Path
      | import("effect").Crypto.Crypto
      | import("@rika/extensions").SkillRegistry.SkillFileSystem,
      OperationError
    >
  }
  readonly authOperations?: AuthOperationOptions
  readonly interactive?: (
    input: Extract<Input, { readonly _tag: "Interactive" }>,
    session: InteractiveSession,
  ) => Effect.Effect<void, OperationUnavailable>
}

export interface AuthOperationOptions {
  readonly layer: Layer.Layer<OpenAiAuth.Service, OperationError>
  readonly assertOpenAiDirect: (workspace: string) => Effect.Effect<void, OperationError>
}
