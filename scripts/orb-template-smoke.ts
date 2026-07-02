import { prepareOrbTemplateContext, type Env } from "./build-orb-template"

interface RunResult {
  readonly stdout: string
  readonly stderr: string
}

const dockerExecutable = Bun.env.RIKA_DOCKER_EXECUTABLE ?? "docker"
const image = Bun.env.RIKA_ORB_SMOKE_IMAGE ?? `rika-orb-smoke:${process.pid}-${Date.now()}`
const keepImage = Bun.env.RIKA_ORB_SMOKE_KEEP_IMAGE === "1"
const checks = [
  { label: "rika --version", command: "rika --version" },
  { label: "git --version", command: "git --version" },
  { label: "tmux -V", command: "tmux -V" },
  { label: "rg --version", command: "rg --version" },
] as const

const context = await prepareOrbTemplateContext(Bun.env)

try {
  await run(dockerExecutable, ["build", "--platform", "linux/amd64", "-t", image, "-f", "e2b.Dockerfile", "."], context)
  for (const check of checks) {
    const result = await run(
      dockerExecutable,
      ["run", "--rm", "--platform", "linux/amd64", image, "bash", "-lc", check.command],
      context,
    )
    if (`${result.stdout}\n${result.stderr}`.trim().length === 0) {
      throw new Error(`Orb template smoke check produced no output: ${check.label}`)
    }
  }
  console.log(JSON.stringify({ image, context, checks: checks.map((check) => check.label) }))
} finally {
  if (!keepImage) {
    await run(dockerExecutable, ["image", "rm", "-f", image], context).catch(() => undefined)
  }
}

async function run(command: string, args: ReadonlyArray<string>, cwd: string, env: Env = Bun.env): Promise<RunResult> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: definedEnv(env),
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(
      [`${command} ${args.join(" ")} exited with code ${exitCode}`, stderr, stdout].filter(Boolean).join("\n"),
    )
  }
  return { stdout, stderr }
}

function definedEnv(env: Env) {
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) output[key] = value
  }
  return output
}
