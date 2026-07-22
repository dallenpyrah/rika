import * as BunServices from "@effect/platform-bun/BunServices"
import * as Transcript from "@rika/transcript"
import { expect, test } from "vitest"
import { Database as NativeDatabase } from "bun:sqlite"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { Database, Thread, ThreadRepository } from "../src"
import * as TurnRepository from "../src/turn-repository"
import * as TranscriptRepository from "../src/transcript-repository"
import * as Turn from "../src/turn-schema"

const id = Thread.ThreadId.make("thread-a")

const create = (
  repository: TurnRepository.Interface,
  input: Omit<TurnRepository.CreateInput, "executionRoute" | "queueCapacity"> & { readonly queueCapacity?: number },
) =>
  repository.createForSubmission({
    queueCapacity: 128,
    ...input,
    executionRoute: Turn.testExecutionRoute(),
  })

const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })

test("reopens a completed nested transcript through the SQLite page", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-nested-transcript-" })
      const filename = `${directory}/rika.db`
      const database = Database.layer(filename)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        TranscriptRepository.layer.pipe(Layer.provide(database)),
      )
      const expected = yield* Effect.scoped(
        Effect.gen(function* () {
          const threads = yield* ThreadRepository.Service
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          yield* threads.create({ id, workspace: "/work/nested", title: "Nested", now: 1 })
          const target = yield* create(turns, {
            id: Turn.TurnId.make("nested-turn"),
            threadId: id,
            prompt: "delegate",
            now: 2,
          })
          const completed = yield* turns.setStatus(target.id, "completed", "parent-done", 3)
          const childId = "nested-turn:child:agent"
          const parent = Transcript.project(target.id, target.prompt, [
            {
              cursor: "agent",
              sequence: 0,
              type: "tool.call.requested",
              createdAt: 2,
              data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "inspect" } },
            },
            {
              cursor: "spawned",
              sequence: 1,
              type: "child_run.spawned",
              createdAt: 2,
              data: { tool_call_id: "agent", child_execution_id: `execution:${childId}` },
            },
            { cursor: "parent-done", sequence: 2, type: "execution.completed", createdAt: 3 },
          ])
          const child = Transcript.project(childId, "", [
            {
              cursor: "answer",
              sequence: 0,
              type: "model.output.completed",
              createdAt: 3,
              text: "## Complete\n\n**Checks passed.**",
            },
            { cursor: "child-done", sequence: 1, type: "execution.completed", createdAt: 3 },
          ])
          const projection = Transcript.withNestedProjections(parent, [
            { parentId: `${target.id}:agent`, projection: child },
          ])
          yield* transcripts.replace(completed, projection)
          return projection.units
        }).pipe(provideLayer(layer)),
      )
      const reopenedDatabase = Database.layer(filename)
      const reopened = Layer.mergeAll(
        reopenedDatabase,
        TranscriptRepository.layer.pipe(Layer.provide(reopenedDatabase)),
      )
      const page = yield* Effect.scoped(
        Effect.gen(function* () {
          const transcripts = yield* TranscriptRepository.Service
          return yield* transcripts.page(id, { limit: 200 })
        }).pipe(provideLayer(reopened)),
      )
      expect(page.entries.map((entry) => entry.unit)).toEqual([...expected])
      expect(page.entries.filter((entry) => entry.unit.parentId === "nested-turn:agent")).toHaveLength(2)
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("rejects an incompatible database without mutating it", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-incompatible-" })
      const filename = `${directory}/rika.db`
      yield* Effect.sync(() => {
        const database = new NativeDatabase(filename)
        database.exec("CREATE TABLE old_sessions (id TEXT PRIMARY KEY)")
        database.close()
      })
      const before = yield* fileSystem.readFile(filename)
      const result = yield* Effect.result(Effect.scoped(Layer.build(Database.layer(filename))))
      const after = yield* fileSystem.readFile(filename)
      const files = yield* fileSystem.readDirectory(directory)
      const names = yield* Effect.sync(() => {
        const database = new NativeDatabase(filename, { readonly: true })
        const rows = database
          .query<
            { name: string },
            []
          >("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all()
        database.close()
        return rows.map((row) => row.name)
      })
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(String(result.failure)).toContain("Use a fresh Rika data root")
      expect([...after]).toEqual([...before])
      expect(files).toEqual(["rika.db"])
      expect(names).toEqual(["old_sessions"])
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("rejects partial and future schemas without changing them", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-schema-shape-" })
      const partial = `${directory}/partial.db`
      yield* Effect.sync(() => {
        const database = new NativeDatabase(partial)
        database.exec("CREATE TABLE rika_workspaces (path TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL)")
        database.close()
      })
      const partialBefore = yield* fileSystem.readFile(partial)
      const partialResult = yield* Effect.result(Effect.scoped(Layer.build(Database.layer(partial))))
      expect(partialResult._tag).toBe("Failure")
      if (partialResult._tag === "Failure")
        expect(String(partialResult.failure)).toContain("Use a fresh Rika data root")
      expect([...(yield* fileSystem.readFile(partial))]).toEqual([...partialBefore])

      const extra = `${directory}/extra.db`
      yield* Effect.scoped(Layer.build(Database.layer(extra)))
      yield* Effect.sync(() => {
        const database = new NativeDatabase(extra)
        database.exec(`
          INSERT INTO rika_migrations (migration_id, name) VALUES (15, 'future_schema');
          CREATE TABLE future_product_state (id TEXT PRIMARY KEY);
        `)
        database.close()
      })
      const extraBefore = yield* fileSystem.readFile(extra)
      const extraResult = yield* Effect.result(Effect.scoped(Layer.build(Database.layer(extra))))
      expect(extraResult._tag).toBe("Failure")
      if (extraResult._tag === "Failure") expect(String(extraResult.failure)).toContain("Use a fresh Rika data root")
      expect([...(yield* fileSystem.readFile(extra))]).toEqual([...extraBefore])
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("rejects a corrupt database without changing it", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-corrupt-" })
      const filename = `${directory}/rika.db`
      yield* fileSystem.writeFile(filename, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))
      const before = yield* fileSystem.readFile(filename)
      const result = yield* Effect.result(Effect.scoped(Layer.build(Database.layer(filename))))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(String(result.failure)).toContain("Use a fresh Rika data root")
      expect([...(yield* fileSystem.readFile(filename))]).toEqual([...before])
      expect(yield* fileSystem.readDirectory(directory)).toEqual(["rika.db"])
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("finishes current bootstrap after an empty SQLite file survives startup", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-empty-bootstrap-" })
      const filename = `${directory}/rika.db`
      yield* Effect.sync(() => {
        const database = new NativeDatabase(filename)
        database.exec("PRAGMA journal_mode = WAL")
        database.close()
      })
      expect((yield* fileSystem.stat(filename)).size).toBeGreaterThan(0n)
      yield* Effect.scoped(Layer.build(Database.layer(filename)))
      const names = yield* Effect.sync(() => {
        const database = new NativeDatabase(filename, { readonly: true })
        const rows = database
          .query<
            { name: string },
            []
          >("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all()
        database.close()
        return rows.map((row) => row.name)
      })
      expect(names).toContain("rika_threads")
      expect(names).toContain("rika_transcript_units")
      expect(names).toContain("rika_migrations")
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("rejects structurally fresh database files with SQLite sidecars without changing them", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-empty-sidecars-" })
      for (const [name, initialize, suffix] of [
        ["zero-wal", false, "-wal"],
        ["zero-shm", false, "-shm"],
        ["header-wal", true, "-wal"],
      ] as const) {
        const filename = `${directory}/${name}/rika.db`
        yield* fileSystem.makeDirectory(`${directory}/${name}`, { recursive: true })
        if (initialize)
          yield* Effect.sync(() => {
            const database = new NativeDatabase(filename)
            database.close()
          })
        else yield* fileSystem.writeFile(filename, new Uint8Array())
        yield* fileSystem.writeFileString(`${filename}${suffix}`, "recovery-state")
        const before = yield* Effect.all([fileSystem.readFile(filename), fileSystem.readFile(`${filename}${suffix}`)])
        const result = yield* Effect.result(Effect.scoped(Layer.build(Database.layer(filename))))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(String(result.failure)).toContain("Use a fresh Rika data root")
        const after = yield* Effect.all([fileSystem.readFile(filename), fileSystem.readFile(`${filename}${suffix}`)])
        expect(after.map((bytes) => Array.from(bytes))).toEqual(before.map((bytes) => Array.from(bytes)))
      }
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("enforces current foreign keys and cascades thread deletion", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-foreign-keys-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        TranscriptRepository.layer.pipe(Layer.provide(database)),
      )
      yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const transcripts = yield* TranscriptRepository.Service
        const sql = yield* SqlClient
        const foreignKeys = yield* sql`PRAGMA foreign_keys`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ foreign_keys: Schema.Literal(1) })))),
        )
        expect(foreignKeys).toEqual([{ foreign_keys: 1 }])
        yield* threads.create({ id, workspace: "/work", title: "Cascade", now: 1 })
        const turn = yield* create(turns, {
          id: Turn.TurnId.make("cascade-turn"),
          threadId: id,
          prompt: "cascade",
          now: 2,
        })
        yield* transcripts.replace(turn, Transcript.empty(turn.id, turn.prompt))
        const orphan = yield* Effect.result(sql`INSERT INTO rika_turns
          (id, thread_id, prompt, status, created_at, updated_at)
          VALUES ('orphan', 'missing-thread', 'orphan', 'accepted', 3, 3)`)
        expect(orphan._tag).toBe("Failure")
        yield* sql`DELETE FROM rika_threads WHERE id = ${id}`
        const counts = yield* sql`SELECT
          (SELECT COUNT(*) FROM rika_turns) AS turns,
          (SELECT COUNT(*) FROM rika_thread_queue_state) AS queues,
          (SELECT COUNT(*) FROM rika_transcript_checkpoints) AS checkpoints,
          (SELECT COUNT(*) FROM rika_transcript_units) AS units`.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Array(
                Schema.Struct({
                  turns: Schema.Literal(0),
                  queues: Schema.Literal(0),
                  checkpoints: Schema.Literal(0),
                  units: Schema.Literal(0),
                }),
              ),
            ),
          ),
        )
        expect(counts).toEqual([{ turns: 0, queues: 0, checkpoints: 0, units: 0 }])
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})
