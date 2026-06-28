import { $ } from "bun"

const artifactName = `rika-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`
const artifactPath = `dist/release/${artifactName}`

await $`bun run package`

const help = await runArtifact(["--help"])
if (help.exitCode !== 0 || !combined(help).includes("SUBCOMMANDS")) {
  fail("compiled CLI did not render help", help)
}

const doctor = await runArtifact(["doctor"])
if (doctor.exitCode !== 0) fail("compiled CLI doctor command failed", doctor)
const doctorReport = parseDoctorReport(doctor.stdout)
if (doctorReport.telemetry !== "disabled") {
  fail("compiled CLI doctor report did not declare telemetry disabled", doctor)
}

console.log(JSON.stringify({ artifact: artifactPath, checks: ["help", "doctor"] }))

interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

async function runArtifact(args: ReadonlyArray<string>): Promise<RunResult> {
  const child = Bun.spawn([artifactPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      RIKA_DATA_DIR: `${Bun.env.PWD ?? process.cwd()}/.rika-package-smoke`,
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
