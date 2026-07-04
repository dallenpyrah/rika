import { Config, Time } from "@rika/core"
import { Embeddings } from "@rika/llm"
import { Database, ThreadMemoryStore } from "@rika/persistence"
import { Common, Ids } from "@rika/schema"
import type { Call } from "@rika/schema/tool"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as ThreadService from "./thread-service"
import * as ToolRegistry from "./tool-registry"
import * as WorkspaceIdentity from "./workspace-identity"

const defaultLimit = 5
const maxLimit = 10
const snippetChars = 500
const millisPerDay = 86_400_000

export interface SearchInput {
  readonly query: string
  readonly limit?: number
  readonly current_thread_id?: Ids.ThreadId
}

export interface Hit {
  readonly thread_id: Ids.ThreadId
  readonly turn_id: Ids.TurnId
  readonly score: number
  readonly thread_title: string | null
  readonly age_days: number
  readonly snippet: string
}

export type SearchOutput =
  | {
      readonly unavailable: true
      readonly reason: string
    }
  | {
      readonly unavailable: false
      readonly results: ReadonlyArray<Hit>
    }

export class ThreadMemoryError extends Schema.TaggedErrorClass<ThreadMemoryError>()("ThreadMemoryError", {
  message: Schema.String,
  operation: Schema.String,
  thread_id: Schema.optional(Ids.ThreadId),
}) {}

export type RunError =
  | Database.DatabaseError
  | ThreadMemoryStore.ThreadMemoryStoreError
  | ThreadService.Error
  | Embeddings.EmbeddingsProviderError
  | Embeddings.EmbeddingsValidationError
  | ThreadMemoryError

export interface Interface {
  readonly search: (input: SearchInput) => Effect.Effect<SearchOutput, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/ThreadMemory") {}

export const fakeLayer = (handler?: Interface["search"]) =>
  Layer.succeed(
    Service,
    Service.of({
      search: Effect.fn("ThreadMemory.search.fake")(function* (input: SearchInput) {
        if (handler !== undefined) return yield* handler(input)
        return { unavailable: true, reason: "not configured" }
      }),
    }),
  )

export const layer: Layer.Layer<
  Service,
  never,
  Config.Service | Embeddings.Service | ThreadMemoryStore.Service | ThreadService.Service | Time.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const embeddings = yield* Embeddings.Service
    const store = yield* ThreadMemoryStore.Service
    const threads = yield* ThreadService.Service
    const time = yield* Time.Service

    return Service.of({
      search: Effect.fn("ThreadMemory.search")(function* (input: SearchInput) {
        const query = input.query.trim()
        if (query.length === 0) {
          return yield* new ThreadMemoryError({ message: "Thread memory query must not be empty", operation: "search" })
        }
        const values = yield* config.get
        const workspaceId = yield* workspaceIdForSearch(threads, values.workspace_root, input.current_thread_id)
        const limit = clamp(input.limit ?? defaultLimit, 1, maxLimit)
        const embedded = yield* embeddings.embed([query]).pipe(
          Effect.flatMap((vectors) => {
            const vector = vectors[0]
            return vector === undefined
              ? Effect.fail(
                  new ThreadMemoryError({
                    message: "Embedding provider returned no vector",
                    operation: "search",
                  }),
                )
              : Effect.succeed(vector)
          }),
          Effect.map((vector) => ({ _tag: "available" as const, vector })),
          Effect.catchTag("EmbeddingsUnavailable", (error) =>
            Effect.succeed({ _tag: "unavailable" as const, reason: error.message }),
          ),
        )
        if (embedded._tag === "unavailable") return { unavailable: true, reason: embedded.reason }

        const rows = yield* store.search(embedded.vector, {
          workspace_id: workspaceId,
          limit,
          ...(input.current_thread_id === undefined ? {} : { exclude_thread_id: input.current_thread_id }),
        })
        const now = yield* time.nowMillis
        const results = yield* Effect.forEach(rows, (result) => hitFromResult(threads, now, result))
        return { unavailable: false, results }
      }),
    })
  }),
)

export const search = Effect.fn("ThreadMemory.search.call")(function* (input: SearchInput) {
  const service = yield* Service
  return yield* service.search(input)
})

export interface ToolInput extends Schema.Schema.Type<typeof ToolInput> {}
export const ToolInput = Schema.Struct({
  query: Schema.String,
  limit: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Agent.ThreadMemory.ToolInput" })

export const toolDefinitions = (service: Interface): ReadonlyArray<ToolRegistry.Definition> => [
  {
    tool: Tool.make("thread_memory", {
      description:
        "Search your own past conversations in this workspace. Use before re-deriving a fix or decision that may already exist.",
      parameters: ToolInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("ThreadMemory.tool.execute")(function* (call: Call) {
      const decoded = Schema.decodeUnknownOption(ToolInput)(call.input)
      if (Option.isNone(decoded)) {
        return yield* new ToolRegistry.ToolRegistryError({
          message: "thread_memory input must include a string query",
          name: call.name,
          retryable: false,
        })
      }
      const currentThreadId = metadataThreadId(call)
      return yield* service
        .search({
          query: decoded.value.query,
          ...(decoded.value.limit === undefined ? {} : { limit: decoded.value.limit }),
          ...(currentThreadId === undefined ? {} : { current_thread_id: currentThreadId }),
        })
        .pipe(
          Effect.map((result) => resultToJson(result)),
          Effect.mapError(
            (error) =>
              new ToolRegistry.ToolRegistryError({
                message: error.message,
                name: call.name,
                retryable: false,
              }),
          ),
        )
    }),
  },
]

const hitFromResult = (
  threads: ThreadService.Interface,
  now: Common.TimestampMillis,
  result: ThreadMemoryStore.SearchResult,
) =>
  Effect.gen(function* () {
    const summary = yield* threads.preview({ thread_id: result.chunk.thread_id, limit: 1 }).pipe(
      Effect.map((record) => record.summary),
      Effect.catch(() => Effect.succeed(undefined)),
    )
    return {
      thread_id: result.chunk.thread_id,
      turn_id: result.chunk.turn_id,
      score: result.score,
      thread_title: summary?.title_text ?? null,
      age_days: Math.max(0, Math.floor((now - result.chunk.created_at) / millisPerDay)),
      snippet: result.chunk.text.slice(0, snippetChars),
    }
  })

const resultToJson = (result: SearchOutput): Common.JsonValue =>
  result.unavailable
    ? { unavailable: true, reason: result.reason }
    : {
        unavailable: false,
        results: result.results.map((hit) => ({
          thread_id: hit.thread_id,
          turn_id: hit.turn_id,
          score: hit.score,
          thread_title: hit.thread_title,
          age_days: hit.age_days,
          snippet: hit.snippet,
        })),
      }

const metadataThreadId = (call: Call): Ids.ThreadId | undefined => {
  const value =
    typeof call.metadata?.thread_id === "string"
      ? call.metadata.thread_id
      : typeof call.metadata?.parent_thread_id === "string"
        ? call.metadata.parent_thread_id
        : undefined
  return typeof value === "string" ? Ids.ThreadId.make(value) : undefined
}

const workspaceIdForSearch = (
  threads: ThreadService.Interface,
  workspaceRoot: string,
  currentThreadId: Ids.ThreadId | undefined,
): Effect.Effect<Ids.WorkspaceId> => {
  const fallback = WorkspaceIdentity.resolveWorkspaceId({ workspace_root: workspaceRoot })
  if (currentThreadId === undefined) return Effect.succeed(fallback)
  return threads.preview({ thread_id: currentThreadId, limit: 1 }).pipe(
    Effect.map((record) => record.summary.workspace_id),
    Effect.catch(() => Effect.succeed(fallback)),
  )
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
