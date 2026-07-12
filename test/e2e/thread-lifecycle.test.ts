import { expect, test } from "bun:test"
import { binary } from "./process"

const run = (database: string, args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync([binary, ...args], {
    env: { ...process.env, RIKA_DATABASE: database },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

test("packaged thread lifecycle persists across processes", async () => {
  const directory = await Bun.fileURLToPath(new URL(`file://${await Bun.$`mktemp -d`.text()}`.trim()))
  const database = `${directory}/nested/rika.db`
  run(database, ["--help"])
  expect(await Bun.file(`${directory}/nested`).exists()).toBe(false)
  const created = JSON.parse(run(database, ["threads", "new"]))
  run(database, ["threads", "rename", created.id, "Durable thread"])
  run(database, ["threads", "label", created.id, "local", "durable"])
  run(database, ["threads", "pin", created.id])
  const listed = JSON.parse(run(database, ["threads", "list"]))
  expect(listed).toHaveLength(1)
  expect(listed[0].title).toBe("Durable thread")
  expect(listed[0].pinned).toBe(true)
  run(database, ["threads", "archive", created.id])
  expect(JSON.parse(run(database, ["threads", "list"]))).toEqual([])
  const searched = JSON.parse(run(database, ["threads", "search", "durable", "--include-archived"]))
  expect(searched[0].labels).toEqual(["local", "durable"])
  run(database, ["threads", "unarchive", created.id])
  run(database, ["threads", "delete", created.id])
  expect(JSON.parse(run(database, ["threads", "list", "--include-archived"]))).toEqual([])
}, 30_000)
