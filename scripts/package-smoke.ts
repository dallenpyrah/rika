import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

const platform = `${process.platform}-${process.arch === "x64" ? "x64" : "arm64"}`
const root = new URL("..", import.meta.url).pathname
const temporary = await mkdtemp(join(tmpdir(), "rika-artifact-"))
const home = join(temporary, "home")
const state = join(temporary, "state")
await mkdir(home)
const archive = join(root, "artifacts", `rika-${platform}.tar.gz`)
const extracted = Bun.spawnSync(["tar", "-xzf", archive, "-C", temporary])
if (extracted.exitCode !== 0) throw new Error(extracted.stderr.toString())
const binary = join(temporary, `rika-${platform}`, "bin", "rika")
const env = {
  ...process.env,
  HOME: home,
  RIKA_DATABASE: join(state, "product.db"),
  RIKA_RELAY_DATABASE: join(state, "relay.db"),
}
const run = (args: string[]) => Bun.spawnSync([binary, ...args], { cwd: temporary, env })
try {
  for (const args of [["--help"], ["--version"], ["tools", "list"], ["threads", "new"], ["threads", "list"]]) {
    const result = run(args)
    if (result.exitCode !== 0) throw new Error(`Artifact command failed: ${args.join(" ")}\n${result.stderr}`)
  }
  const files = await readdir(state)
  if (!files.includes("product.db")) throw new Error("Product migration database was not created")
  const database = new Database(join(state, "product.db"), { readonly: true })
  const migrations = database.query("select count(*) as count from rika_migrations").get() as { count: number }
  database.close()
  if (migrations.count < 1) throw new Error("Product migrations were not applied and retained across reopen")
  const tree = Bun.spawnSync(["find", join(temporary, `rika-${platform}`), "-type", "l", "-print"]).stdout.toString()
  if (tree.trim()) throw new Error(`Artifact contains links: ${tree}`)
  const inventory = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString().toLowerCase()
  for (const excluded of ["rivet", "postgres", "docker.sock", "baton/node_modules", "relay/node_modules"])
    if (inventory.includes(excluded)) throw new Error(`Artifact contains excluded dependency: ${excluded}`)
  const child = Bun.spawn([binary], {
    cwd: temporary,
    env: { ...env, TERM: "xterm-256color" },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  })
  await Bun.sleep(500)
  child.kill("SIGTERM")
  const exit = await Promise.race([child.exited, Bun.sleep(5_000).then(() => -1)])
  if (exit === -1) throw new Error("Artifact did not tear down after SIGTERM")
} finally {
  await rm(temporary, { recursive: true, force: true })
}
