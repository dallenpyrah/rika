import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config, Settings } from "@rika/core"
import { Embeddings } from "@rika/llm"
import { ThreadMemoryStore } from "@rika/persistence"
import { Common, Ide, Ids } from "@rika/schema"
import { Effect, Layer } from "effect"
import { ContextResolver, ThreadService } from "../src/index"

const threadId = Ids.ThreadId.make("thread_context")
const turnId = Ids.TurnId.make("turn_context")
const memoryThreadId = Ids.ThreadId.make("thread_context_memory")
const memoryTurnId = Ids.TurnId.make("turn_context_memory")
const now = Common.TimestampMillis.make(2_000_000_000_000)

const tempWorkspace = () => mkdtemp(join(tmpdir(), "rika-context-"))

const configLayer = (workspaceRoot: string) =>
  Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: join(workspaceRoot, ".rika"),
    default_mode: "smart",
  })

const run = <A, E>(workspaceRoot: string, effect: Effect.Effect<A, E, ContextResolver.Service>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(ContextResolver.layer),
      Effect.provide(
        Layer.mergeAll(
          configLayer(workspaceRoot),
          ThreadService.fakeLayer({
            reference: (input) =>
              Effect.succeed({
                thread_id: input.thread_id,
                rendered: `Referenced ${input.thread_id}`,
                entries: [`Referenced ${input.thread_id}`],
                total_chars: `Referenced ${input.thread_id}`.length,
                truncated: false,
              }),
          }),
        ),
      ),
    ),
  )

const runWithMemory = <A, E>(
  workspaceRoot: string,
  effect: Effect.Effect<A, E, ContextResolver.Service>,
  options: {
    readonly autoContext?: boolean
    readonly chunks?: ReadonlyArray<ThreadMemoryStore.ThreadMemoryChunk>
    readonly currentWorkspaceId?: Ids.WorkspaceId
    readonly queryVector?: ReadonlyArray<number>
    readonly references?: Array<Ids.ThreadId>
  } = {},
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(ContextResolver.layer),
      Effect.provide(
        Layer.mergeAll(
          configLayer(workspaceRoot),
          Settings.layerFromEnv(
            {
              HOME: workspaceRoot,
              ...(options.autoContext === true ? { RIKA_MEMORY_AUTO_CONTEXT: "true" } : {}),
            },
            workspaceRoot,
          ),
          ThreadMemoryStore.memoryLayer(options.chunks ?? []),
          vectorEmbeddingsLayer(options.queryVector ?? [1, 0]),
          ThreadService.fakeLayer({
            preview: (input) =>
              Effect.succeed({
                summary: summary(input.thread_id, options.currentWorkspaceId ?? Ids.WorkspaceId.make(workspaceRoot)),
                events: [],
              }),
            reference: (input) =>
              Effect.sync(() => {
                options.references?.push(input.thread_id)
                return {
                  thread_id: input.thread_id,
                  rendered: `Memory reference ${input.thread_id}`,
                  entries: [`Memory reference ${input.thread_id}`],
                  total_chars: `Memory reference ${input.thread_id}`.length,
                  truncated: false,
                }
              }),
          }),
        ),
      ),
    ),
  )

describe("ContextResolver", () => {
  test("loads workspace AGENTS.md, mentioned files, images, and thread references", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "AGENTS.md"), "Use Bun tests.\n")
    await writeFile(join(root, "README.md"), "# Rika\n")
    await writeFile(join(root, "screenshot.png"), new Uint8Array([137, 80, 78, 71]))

    const context = await run(
      root,
      ContextResolver.resolveContext({
        thread_id: threadId,
        turn_id: turnId,
        content: "Read @README.md and inspect @screenshot.png like @T-12345678-1234-1234-1234-123456789abc",
      }),
    )
    const entries = workspaceEntries(context)

    expect(entries.map((entry) => entry.kind)).toEqual(["guidance", "file", "image", "thread-reference"])
    expect(entries[0]).toMatchObject({ kind: "guidance", path: "AGENTS.md", content: "Use Bun tests.\n" })
    expect(entries[1]).toMatchObject({ kind: "file", path: "README.md", content: "# Rika\n" })
    expect(entries[2]).toMatchObject({ kind: "image", path: "screenshot.png", media_type: "image/png" })
    expect(entries[3]).toMatchObject({
      kind: "thread-reference",
      thread_reference: "T-12345678-1234-1234-1234-123456789abc",
      content: "Referenced T-12345678-1234-1234-1234-123456789abc",
    })
    expect(context.rendered).toContain("untrusted-workspace-and-user-content")
  })

  test("resolves Rika-generated thread ids as thread references", async () => {
    const root = await tempWorkspace()

    const context = await run(
      root,
      ContextResolver.resolveContext({
        thread_id: threadId,
        turn_id: turnId,
        content: "Continue from @thread_context and /threads/thread_context.",
      }),
    )

    expect(context.entries).toContainEqual(
      expect.objectContaining({
        kind: "thread-reference",
        thread_reference: "thread_context",
        content: "Referenced thread_context",
      }),
    )
  })

  test("renders IDE active file and diagnostics as untrusted resolved context", async () => {
    const root = await tempWorkspace()
    const ideContext: Ide.ContextSnapshot = {
      workspace_roots: [root],
      active_file: {
        path: "packages/cli/src/runtime.ts",
        language_id: "typescript",
        selection: { range: { start_line: 10, end_line: 12 }, selected_text: "const mode = 'smart'" },
      },
      diagnostics: [
        {
          path: "packages/cli/src/runtime.ts",
          severity: "warning",
          message: "Unused symbol",
          range: { start_line: 11, end_line: 11 },
          source: "tsserver",
        },
      ],
    }

    const context = await run(
      root,
      ContextResolver.resolveContext({
        thread_id: threadId,
        turn_id: turnId,
        content: "Use the editor context",
        ide_context: ideContext,
      }),
    )

    expect(context.entries).toContainEqual(
      expect.objectContaining({
        kind: "file",
        source: "ide:active-file",
        trusted: false,
        path: "packages/cli/src/runtime.ts",
        content: expect.stringContaining("const mode = 'smart'"),
      }),
    )
    expect(context.entries).toContainEqual(
      expect.objectContaining({
        kind: "file",
        source: "ide:diagnostics",
        trusted: false,
        content: expect.stringContaining("warning [tsserver]: Unused symbol"),
      }),
    )
    expect(context.metadata).toMatchObject({ ide_context: true })
  })

  test("does not parse thread-looking file mentions as thread references", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "thread_context.ts"), "export const threadContext = true\n")
    await mkdir(join(root, "thread_context"), { recursive: true })
    await writeFile(join(root, "thread_context", "file.ts"), "export const file = true\n")

    const context = await run(
      root,
      ContextResolver.resolveContext({
        thread_id: threadId,
        turn_id: turnId,
        content: "Read @thread_context.ts and @thread_context/file.ts",
      }),
    )

    expect(context.entries.filter((entry) => entry.kind === "thread-reference")).toEqual([])
    expect(workspaceEntries(context).filter((entry) => entry.kind === "file")).toHaveLength(2)
  })

  test("uses AGENT.md or CLAUDE.md fallback when AGENTS.md is absent", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "AGENT.md"), "Fallback singular guidance.\n")

    const context = await run(
      root,
      ContextResolver.resolveContext({ thread_id: threadId, turn_id: turnId, content: "hello" }),
    )

    expect(workspaceEntries(context)).toHaveLength(1)
    expect(workspaceEntries(context)[0]).toMatchObject({ kind: "guidance", path: "AGENT.md" })
  })

  test("includes subtree guidance only after a relevant file is mentioned", async () => {
    const root = await tempWorkspace()
    await mkdir(join(root, "packages", "api", "src"), { recursive: true })
    await writeFile(join(root, "AGENTS.md"), "Root guidance.\n")
    await writeFile(join(root, "packages", "api", "AGENTS.md"), "API guidance.\n")
    await writeFile(join(root, "packages", "api", "src", "handler.ts"), "export const handler = 1\n")

    const withoutMention = await run(
      root,
      ContextResolver.resolveContext({ thread_id: threadId, turn_id: turnId, content: "hello" }),
    )
    const withMention = await run(
      root,
      ContextResolver.resolveContext({
        thread_id: threadId,
        turn_id: turnId,
        content: "Read @packages/api/src/handler.ts",
      }),
    )

    expect(workspaceEntries(withoutMention).map((entry) => entry.path)).toEqual(["AGENTS.md"])
    expect(workspaceEntries(withMention).map((entry) => entry.path)).toEqual([
      "AGENTS.md",
      "packages/api/AGENTS.md",
      "packages/api/src/handler.ts",
    ])
  })

  test("applies frontmatter globs on AGENTS-mentioned guidance files", async () => {
    const root = await tempWorkspace()
    await mkdir(join(root, "docs"), { recursive: true })
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "AGENTS.md"), "See @docs/typescript.md and @docs/ruby.md\n")
    await writeFile(join(root, "docs", "typescript.md"), "---\nglobs:\n  - '**/*.ts'\n---\nUse TypeScript rules.\n")
    await writeFile(join(root, "docs", "ruby.md"), "---\nglobs:\n  - '**/*.rb'\n---\nUse Ruby rules.\n")
    await writeFile(join(root, "src", "main.ts"), "export const main = true\n")

    const context = await run(
      root,
      ContextResolver.resolveContext({ thread_id: threadId, turn_id: turnId, content: "Open @src/main.ts" }),
    )

    expect(workspaceEntries(context).map((entry) => entry.path)).toEqual([
      "AGENTS.md",
      "docs/typescript.md",
      "src/main.ts",
    ])
    expect(context.rendered).toContain("Use TypeScript rules")
    expect(context.rendered).not.toContain("Use Ruby rules")
  })

  test("ignores @mentions inside code blocks", async () => {
    const root = await tempWorkspace()
    await writeFile(join(root, "README.md"), "# hidden\n")

    const context = await run(
      root,
      ContextResolver.resolveContext({
        thread_id: threadId,
        turn_id: turnId,
        content: "```\n@README.md\n```",
      }),
    )

    expect(context.entries.filter((entry) => entry.kind !== "guidance")).toHaveLength(0)
  })

  test("does not inject thread memory context by default", async () => {
    const root = await tempWorkspace()

    const context = await runWithMemory(
      root,
      ContextResolver.resolveContext({
        thread_id: threadId,
        turn_id: turnId,
        content: "reuse the prior fix",
      }),
      {
        chunks: [
          memoryChunk("chunk_context_memory_default", memoryThreadId, memoryTurnId, "Prior fix context", [1, 0], root),
        ],
      },
    )

    expect(context.entries.filter((entry) => entry.source === "thread-memory")).toEqual([])
  })

  test("injects at most three thread memory references above the similarity threshold", async () => {
    const root = await tempWorkspace()
    const references: Array<Ids.ThreadId> = []

    const context = await runWithMemory(
      root,
      ContextResolver.resolveContext({
        thread_id: threadId,
        turn_id: turnId,
        content: "reuse the prior fix",
      }),
      {
        autoContext: true,
        references,
        chunks: [
          memoryChunk(
            "chunk_context_memory_one",
            Ids.ThreadId.make("thread_context_memory_one"),
            memoryTurnId,
            "one",
            [1, 0],
            root,
          ),
          memoryChunk(
            "chunk_context_memory_two",
            Ids.ThreadId.make("thread_context_memory_two"),
            memoryTurnId,
            "two",
            [0.9, 0.1],
            root,
          ),
          memoryChunk(
            "chunk_context_memory_three",
            Ids.ThreadId.make("thread_context_memory_three"),
            memoryTurnId,
            "three",
            [0.8, 0.2],
            root,
          ),
          memoryChunk(
            "chunk_context_memory_four",
            Ids.ThreadId.make("thread_context_memory_four"),
            memoryTurnId,
            "four",
            [1, 0],
            root,
          ),
          memoryChunk(
            "chunk_context_memory_low",
            Ids.ThreadId.make("thread_context_memory_low"),
            memoryTurnId,
            "low",
            [0, 1],
            root,
          ),
          memoryChunk("chunk_context_memory_current", threadId, memoryTurnId, "current", [1, 0], root),
        ],
      },
    )

    const memoryEntries = context.entries.filter((entry) => entry.source === "thread-memory")
    expect(memoryEntries).toHaveLength(3)
    expect(memoryEntries.every((entry) => entry.kind === "thread-reference" && !entry.trusted)).toBe(true)
    expect(memoryEntries.map((entry) => entry.thread_reference)).not.toContain(threadId)
    expect(memoryEntries.map((entry) => entry.thread_reference)).not.toContain("thread_context_memory_low")
    expect(references).toHaveLength(3)
  })

  test("does not inject thread memory references below the similarity threshold", async () => {
    const root = await tempWorkspace()

    const context = await runWithMemory(
      root,
      ContextResolver.resolveContext({
        thread_id: threadId,
        turn_id: turnId,
        content: "reuse the prior fix",
      }),
      {
        autoContext: true,
        chunks: [
          memoryChunk("chunk_context_memory_below", memoryThreadId, memoryTurnId, "Unrelated context", [0, 1], root),
        ],
      },
    )

    expect(context.entries.filter((entry) => entry.source === "thread-memory")).toEqual([])
  })

  test("uses the current thread workspace id for auto memory references", async () => {
    const root = await tempWorkspace()
    const projectWorkspaceId = Ids.WorkspaceId.make("project:context-memory")
    const projectMemoryThreadId = Ids.ThreadId.make("thread_context_memory_project")

    const context = await runWithMemory(
      root,
      ContextResolver.resolveContext({
        thread_id: threadId,
        turn_id: turnId,
        content: "reuse the prior project fix",
      }),
      {
        autoContext: true,
        currentWorkspaceId: projectWorkspaceId,
        chunks: [
          memoryChunk(
            "chunk_context_memory_project",
            projectMemoryThreadId,
            memoryTurnId,
            "Project context",
            [1, 0],
            root,
            { workspace_id: projectWorkspaceId },
          ),
          memoryChunk("chunk_context_memory_root", memoryThreadId, memoryTurnId, "Root context", [1, 0], root),
        ],
      },
    )

    expect(
      context.entries.filter((entry) => entry.source === "thread-memory").map((entry) => entry.thread_reference),
    ).toEqual([projectMemoryThreadId])
  })
})

const workspaceEntries = (context: ContextResolver.ResolvedContext) =>
  context.entries.filter((entry) => entry.path === undefined || !entry.path.startsWith("/"))

const vectorEmbeddingsLayer = (vector: ReadonlyArray<number>) =>
  Layer.succeed(
    Embeddings.Service,
    Embeddings.Service.of({
      dimensions: vector.length,
      availability: Effect.succeed({ available: true, model: "context-test", dimensions: vector.length }),
      embed: Effect.fn("Embeddings.embed.contextResolverTest")(function* (texts: ReadonlyArray<string>) {
        return texts.map(() => new Float32Array(vector))
      }),
    }),
  )

const memoryChunk = (
  id: string,
  thread_id: Ids.ThreadId,
  turn_id: Ids.TurnId,
  text: string,
  embedding: ReadonlyArray<number>,
  workspaceRoot: string,
  overrides: Partial<ThreadMemoryStore.ThreadMemoryChunk> = {},
): ThreadMemoryStore.ThreadMemoryChunk => ({
  id: Ids.ThreadMemoryChunkId.make(id),
  thread_id,
  turn_id,
  workspace_id: Ids.WorkspaceId.make(workspaceRoot),
  text,
  embedding: new Float32Array(embedding),
  created_at: now,
  ...overrides,
})

const summary = (thread_id: Ids.ThreadId, workspace_id: Ids.WorkspaceId): ThreadService.ThreadSummary => ({
  thread_id,
  workspace_id,
  diff: { additions: 0, modifications: 0, deletions: 0 },
  archived: false,
  visibility: "private",
  created_at: now,
  updated_at: now,
})
