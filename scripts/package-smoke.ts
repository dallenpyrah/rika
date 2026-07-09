import { $ } from "bun"

const artifactName = `rika-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`
const artifactPath = `dist/release/${artifactName}`

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

console.log(JSON.stringify({ artifact: artifactPath, checks: ["help", "doctor"] }))

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
