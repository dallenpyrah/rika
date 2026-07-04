import { describe, expect, test } from "bun:test"
import { Config, Time } from "@rika/core"
import { Embeddings } from "@rika/llm"
import { ThreadMemoryStore } from "@rika/persistence"
import { Common, Ids } from "@rika/schema"
import { Effect, Layer } from "effect"
import { ThreadMemory, ToolAccess, ThreadService } from "../src/index"

const workspaceRoot = "/workspace/rika-thread-memory-test"
const workspaceId = Ids.WorkspaceId.make(workspaceRoot)
const projectWorkspaceId = Ids.WorkspaceId.make("project:thread_memory_project")
const currentThreadId = Ids.ThreadId.make("thread_memory_current")
const pastThreadId = Ids.ThreadId.make("thread_memory_past")
const projectPastThreadId = Ids.ThreadId.make("thread_memory_project_past")
const currentTurnId = Ids.TurnId.make("turn_memory_current")
const pastTurnId = Ids.TurnId.make("turn_memory_past")
const now = Common.TimestampMillis.make(2_000_000_000_000)
const twoDaysAgo = Common.TimestampMillis.make(now - 172_800_000)

describe("ThreadMemory", () => {
  test("searches past workspace chunks while excluding the current thread", async () => {
    const output = await Effect.runPromise(
      ThreadMemory.search({ query: "reuse prior fix", limit: 10, current_thread_id: currentThreadId }).pipe(
        Effect.provide(
          testLayer([
            chunk("chunk_memory_past", pastThreadId, pastTurnId, "Prior fix digest ".repeat(40), [1, 0], {
              created_at: twoDaysAgo,
            }),
            chunk("chunk_memory_current", currentThreadId, currentTurnId, "Current thread digest", [1, 0]),
            chunk(
              "chunk_memory_other_workspace",
              Ids.ThreadId.make("thread_memory_other_workspace"),
              Ids.TurnId.make("turn_memory_other_workspace"),
              "Other workspace digest",
              [1, 0],
              { workspace_id: Ids.WorkspaceId.make("workspace_elsewhere") },
            ),
          ]),
        ),
      ),
    )

    expect(output.unavailable).toBe(false)
    if (output.unavailable) throw new Error(output.reason)
    expect(output.results).toHaveLength(1)
    expect(output.results[0]).toMatchObject({
      thread_id: pastThreadId,
      turn_id: pastTurnId,
      score: 1,
      thread_title: "Past memory thread",
      age_days: 2,
    })
    expect(output.results[0]?.snippet).toHaveLength(500)
  })

  test("uses the current thread workspace id when it differs from the workspace root", async () => {
    const output = await Effect.runPromise(
      ThreadMemory.search({ query: "project fix", current_thread_id: currentThreadId }).pipe(
        Effect.provide(
          testLayer(
            [
              chunk("chunk_memory_project", projectPastThreadId, pastTurnId, "Project workspace digest", [1, 0], {
                workspace_id: projectWorkspaceId,
              }),
              chunk("chunk_memory_root", pastThreadId, pastTurnId, "Root workspace digest", [1, 0], {
                workspace_id: workspaceId,
              }),
            ],
            vectorEmbeddingsLayer([1, 0]),
            (thread_id) => ({
              ...summary(thread_id),
              workspace_id:
                thread_id === currentThreadId || thread_id === projectPastThreadId ? projectWorkspaceId : workspaceId,
              title_text: thread_id === projectPastThreadId ? "Project memory thread" : summary(thread_id).title_text,
            }),
          ),
        ),
      ),
    )

    expect(output.unavailable).toBe(false)
    if (output.unavailable) throw new Error(output.reason)
    expect(output.results.map((result) => result.thread_id)).toEqual([projectPastThreadId])
  })

  test("tool definition returns unavailable data instead of failing when embeddings are unavailable", async () => {
    const service = await Effect.runPromise(
      ThreadMemory.Service.pipe(Effect.provide(testLayer([], Embeddings.layer(Embeddings.optionsFromEnv({}))))),
    )
    const definition = ThreadMemory.toolDefinitions(service)[0]
    if (definition === undefined) throw new Error("thread_memory definition missing")

    const output = await Effect.runPromise(
      definition.execute({
        id: Ids.ToolCallId.make("tool_call_thread_memory_unavailable"),
        name: "thread_memory",
        input: { query: "prior fix" },
        metadata: { thread_id: currentThreadId },
      }),
    )

    expect(output).toMatchObject({ unavailable: true, reason: expect.stringContaining("Embeddings require") })
  })

  test("tool definition excludes subagent parent thread metadata", async () => {
    const service = await Effect.runPromise(
      ThreadMemory.Service.pipe(
        Effect.provide(
          testLayer([
            chunk("chunk_memory_past", pastThreadId, pastTurnId, "Prior fix digest", [1, 0]),
            chunk("chunk_memory_current", currentThreadId, currentTurnId, "Current thread digest", [1, 0]),
          ]),
        ),
      ),
    )
    const definition = ThreadMemory.toolDefinitions(service)[0]
    if (definition === undefined) throw new Error("thread_memory definition missing")

    const output = await Effect.runPromise(
      definition.execute({
        id: Ids.ToolCallId.make("tool_call_thread_memory_parent"),
        name: "thread_memory",
        input: { query: "prior fix" },
        metadata: { parent_thread_id: currentThreadId },
      }),
    )

    expect(output).toMatchObject({
      unavailable: false,
      results: [expect.objectContaining({ thread_id: pastThreadId })],
    })
  })

  test("thread_memory is a read-only tool for turns, checks, and subagents", () => {
    expect([...ToolAccess.readOnlyToolNames]).toContain("thread_memory")
  })
})

const testLayer = (
  chunks: ReadonlyArray<ThreadMemoryStore.ThreadMemoryChunk>,
  embeddingsLayer: Layer.Layer<Embeddings.Service> = vectorEmbeddingsLayer([1, 0]),
  summarize: (thread_id: Ids.ThreadId) => ThreadService.ThreadSummary = summary,
) =>
  ThreadMemory.layer.pipe(
    Layer.provideMerge(
      Config.layerFromValues({
        workspace_root: workspaceRoot,
        data_dir: `${workspaceRoot}/.rika`,
        default_mode: "smart",
      }),
    ),
    Layer.provideMerge(Time.fixedLayer(now)),
    Layer.provideMerge(ThreadMemoryStore.memoryLayer(chunks)),
    Layer.provideMerge(embeddingsLayer),
    Layer.provideMerge(
      ThreadService.fakeLayer({
        preview: (input) =>
          Effect.succeed({
            summary: summarize(input.thread_id),
            events: [],
          }),
      }),
    ),
  )

const vectorEmbeddingsLayer = (vector: ReadonlyArray<number>) =>
  Layer.succeed(
    Embeddings.Service,
    Embeddings.Service.of({
      dimensions: vector.length,
      availability: Effect.succeed({ available: true, model: "test", dimensions: vector.length }),
      embed: Effect.fn("Embeddings.embed.threadMemoryTest")(function* (texts: ReadonlyArray<string>) {
        return texts.map(() => new Float32Array(vector))
      }),
    }),
  )

const chunk = (
  id: string,
  thread_id: Ids.ThreadId,
  turn_id: Ids.TurnId,
  text: string,
  embedding: ReadonlyArray<number>,
  overrides: Partial<ThreadMemoryStore.ThreadMemoryChunk> = {},
): ThreadMemoryStore.ThreadMemoryChunk => ({
  id: Ids.ThreadMemoryChunkId.make(id),
  thread_id,
  turn_id,
  workspace_id: workspaceId,
  text,
  embedding: new Float32Array(embedding),
  created_at: now,
  ...overrides,
})

const summary = (thread_id: Ids.ThreadId): ThreadService.ThreadSummary => ({
  thread_id,
  workspace_id: workspaceId,
  title_text: thread_id === pastThreadId ? "Past memory thread" : "Current memory thread",
  diff: { additions: 0, modifications: 0, deletions: 0 },
  archived: false,
  visibility: "private",
  created_at: now,
  updated_at: now,
})
