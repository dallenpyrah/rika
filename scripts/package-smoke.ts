import { $ } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const artifactName = `rika-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`
const artifactPath = `dist/release/${artifactName}`
const enginePath = join(
  process.cwd(),
  "dist/share/rika/bin",
  process.platform === "win32" ? "rivet-engine.exe" : "rivet-engine",
)

await $`bun run package`

const help = await runArtifact(["--help"])
if (help.exitCode !== 0 || !combined(help).includes("Commands:")) {
  fail("compiled CLI did not render help", help)
}

const doctor = await runArtifact(["doctor"])
if (doctor.exitCode !== 0) fail("compiled CLI doctor command failed", doctor)
const doctorReport = parseDoctorReport(doctor.stdout)
if (doctorReport.telemetry !== "enabled") {
  fail("compiled CLI doctor report did not declare telemetry enabled", doctor)
}

const doctorOff = await runArtifact(["doctor"], { RIKA_TELEMETRY: "off" })
if (parseDoctorReport(doctorOff.stdout).telemetry !== "disabled") {
  fail("compiled CLI doctor report did not honor RIKA_TELEMETRY=off", doctorOff)
}

await smokeServerHealth()

console.log(JSON.stringify({ artifact: artifactPath, checks: ["help", "doctor", "server-health"] }))

interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

async function runArtifact(args: ReadonlyArray<string>, envOverride: Record<string, string> = {}): Promise<RunResult> {
  const child = Bun.spawn([artifactPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      RIKA_API_KEY: Bun.env.RIKA_API_KEY ?? "package-smoke-dummy-key",
      RIKA_DATA_DIR: `${Bun.env.PWD ?? process.cwd()}/.rika-package-smoke`,
      ...envOverride,
    },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

function combined(result: RunResult) {
  return `${result.stdout}\n${result.stderr}`
}

function parseDoctorReport(text: string) {
  const value: unknown = JSON.parse(text)
  if (typeof value !== "object" || value === null || !("config" in value)) return {}
  const config = value.config
  if (typeof config !== "object" || config === null || !("telemetry" in config)) return {}
  return typeof config.telemetry === "string" ? { telemetry: config.telemetry } : {}
}

function fail(message: string, result: RunResult): never {
  console.error(message)
  console.error(combined(result))
  process.exit(1)
}

async function smokeServerHealth() {
  const workspace = await mkdtemp(join(tmpdir(), "rika-package-smoke-"))
  const token = "package-smoke-token"
  const port = 46_000 + Math.floor(Math.random() * 1_000)
  const enginePidsBefore = await rivetEnginePids(enginePath)
  const child = Bun.spawn(
    [artifactPath, "server", "--host", "127.0.0.1", "--port", String(port), "--token", token, "--workspace", workspace],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...Bun.env,
        OPENAI_API_KEY: Bun.env.OPENAI_API_KEY ?? "package-smoke-dummy-key",
        RIKA_API_KEY: Bun.env.RIKA_API_KEY ?? "package-smoke-dummy-key",
        RIKA_DATA_DIR: join(workspace, ".rika"),
        RIKA_SERVER_BACKEND: "native-rivet",
        RIVETKIT_RUNTIME: "native",
      },
    },
  )
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()

  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/health`, token).catch(async (error) => {
      child.kill()
      const [stdoutText, stderrText, exitCode] = await Promise.all([
        stdout.catch(() => ""),
        stderr.catch(() => ""),
        child.exited.catch(() => 1),
      ])
      fail("compiled CLI server did not become healthy", {
        exitCode,
        stdout: stdoutText,
        stderr: `${error instanceof Error ? error.message : String(error)}\n${stderrText}`,
      })
    })
    if (
      health.workspace_root !== workspace ||
      health.data_dir !== join(workspace, ".rika") ||
      health.backend_id !== "native-rivet-edge"
    ) {
      fail("compiled CLI server health returned unexpected workspace metadata", {
        exitCode: 1,
        stdout: JSON.stringify(health),
        stderr: "",
      })
    }
  } finally {
    child.kill()
    await child.exited.catch(() => 0)
    await terminateNewRivetEnginePids(enginePidsBefore, enginePath)
    await rm(workspace, { force: true, recursive: true })
  }
}

async function waitForHealth(url: string, token: string): Promise<Record<string, string>> {
  let lastError = ""
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
      if (response.ok) return readHealth(await response.json())
      lastError = `status ${response.status}`
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause)
    }
    await Bun.sleep(100)
  }
  throw new Error(lastError)
}

function readHealth(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {}
  const result: Record<string, string> = {}
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") result[key] = entryValue
  }
  return result
}

async function terminateNewRivetEnginePids(before: ReadonlySet<number>, commandFilter: string) {
  const targets = [...(await rivetEnginePids(commandFilter))].filter((pid) => !before.has(pid))
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await rivetEnginePids(commandFilter)
    if (targets.every((pid) => !current.has(pid))) return
    await Bun.sleep(100)
  }
  const current = await rivetEnginePids(commandFilter)
  for (const pid of targets) {
    if (!current.has(pid)) continue
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

async function rivetEnginePids(commandFilter: string) {
  const processList = Bun.spawn(["ps", "-axo", "pid=,command="], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const output = await new Response(processList.stdout).text()
  await processList.exited.catch(() => 1)
  const pids = new Set<number>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const command = match[2]
    if (!Number.isFinite(pid) || command === undefined) continue
    if (command.includes(commandFilter) && command.includes("rivet-engine start")) pids.add(pid)
  }
  return pids
}
