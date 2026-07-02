import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = new URL("..", import.meta.url).pathname
const dockerfilePath = join(root, "infra/orb-template/e2b.Dockerfile")
const configPath = join(root, "infra/orb-template/e2b.toml")
const buildScriptPath = join(root, "scripts/build-orb-template.ts")
const smokeScriptPath = join(root, "scripts/orb-template-smoke.ts")
const cliMainPath = join(root, "packages/cli/src/main.ts")
const cliRuntimePath = join(root, "packages/cli/src/runtime.ts")

describe("orb template", () => {
  test("declares the required E2B template image contract", async () => {
    const packageJson = await Bun.file(join(root, "package.json")).json()
    const bunVersion = String(packageJson.packageManager).replace("bun@", "")
    const dockerfile = await readFile(dockerfilePath, "utf8")
    const config = await readFile(configPath, "utf8")

    expect(dockerfile).toContain("FROM debian:12")
    expect(dockerfile).toContain("BUN_INSTALL=/opt/bun")
    expect(dockerfile).not.toContain("BUN_INSTALL=/root/.bun")
    expect(dockerfile).not.toContain("/root/.bun")
    for (const name of ["curl", "ca-certificates", "git", "tmux", "ripgrep", "jq", "unzip", "openssh-client"]) {
      expect(dockerfile).toContain(name)
    }
    expect(dockerfile).toContain(`BUN_VERSION=${bunVersion}`)
    expect(dockerfile).toContain("setup_lts.x")
    expect(dockerfile).toContain("/opt/rika")
    expect(dockerfile).toContain("/opt/rika/bin")
    expect(dockerfile).toContain("/usr/local/bin/rika")
    expect(dockerfile).toContain("/home/user/repo")
    expect(dockerfile).toContain("new-session -A -s rika")
    expect(config).toContain('template_name = "rika-orb"')
    expect(config).toContain('dockerfile = "e2b.Dockerfile"')
  })

  test("exposes owner-facing package scripts", async () => {
    const packageJson = await Bun.file(join(root, "package.json")).json()
    expect(packageJson.scripts["orb:template"]).toBe("bun run scripts/build-orb-template.ts")
    expect(packageJson.scripts["orb:template:contract"]).toBe("bun test scripts/orb-template.test.ts")
    expect(packageJson.scripts["orb:template:smoke"]).toBe("bun run scripts/orb-template-smoke.ts")
  })

  test("declares an image-level smoke script for the orb template", async () => {
    const smoke = await readFile(smokeScriptPath, "utf8")

    expect(smoke).toContain("docker")
    expect(smoke).toContain("build")
    expect(smoke).toContain("run")
    expect(smoke).toContain("rika --version")
    expect(smoke).toContain("git --version")
    expect(smoke).toContain("tmux -V")
    expect(smoke).toContain("rg --version")
  })

  test("resolves the orb template id from env, project, settings, then fallback", async () => {
    const module = await import("./build-orb-template")

    expect(module.resolveOrbTemplateId("project-template", { RIKA_ORB_TEMPLATE: "env-template" })).toBe("env-template")
    expect(module.resolveOrbTemplateId("project-template", {}, "settings-template")).toBe("project-template")
    expect(module.resolveOrbTemplateId(undefined, {}, "settings-template")).toBe("settings-template")
    expect(module.resolveOrbTemplateId(undefined, {})).toBe("rika-orb")
  })

  test("rejects non-Linux package artifacts for the orb image", async () => {
    const module = await import("./build-orb-template")

    expect(() => module.validateOrbPackageManifest({ platform: "darwin", arch: "arm64" })).toThrow("linux-x64")
    expect(() => module.validateOrbPackageManifest({ platform: "linux", arch: "x64" })).not.toThrow()
  })

  test("keeps terminal rendering out of server-only CLI startup", async () => {
    const runtime = await readFile(cliRuntimePath, "utf8")

    expect(runtime).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+"@rika\/tui"/m)
    expect(runtime).toContain('import("@rika/tui")')
  })

  test("fails before invoking tools when E2B_API_KEY is missing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-template-"))
    const log = join(workspace, "commands.log")
    const fakeBin = await fakeExecutable(workspace, "fake-tool", [
      "#!/usr/bin/env bun",
      `await Bun.write(${JSON.stringify(log)}, Bun.argv.slice(2).join(" "), { append: true })`,
    ])

    try {
      const result = await runBuildScript({
        RIKA_BUN_EXECUTABLE: fakeBin,
        RIKA_E2B_EXECUTABLE: fakeBin,
      })

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("E2B_API_KEY")
      expect(await Bun.file(log).exists()).toBe(false)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("packages Linux Rika before invoking the E2B template command", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-template-"))
    const log = join(workspace, "commands.log")
    const templateDir = join(workspace, "template-context")
    const fakeBun = await fakeExecutable(workspace, "fake-bun", [
      "#!/usr/bin/env bun",
      "const { appendFile } = await import('node:fs/promises')",
      `await appendFile(${JSON.stringify(log)}, "bun " + Bun.argv.slice(2).join(" ") + "\\n")`,
      "await Bun.write('dist/release/rika-linux-x64', 'linux-binary')",
      "await Bun.write('dist/release/rika-linux-x64.json', JSON.stringify({ platform: 'linux', arch: 'x64' }))",
      "await Bun.write('dist/share/rika/drizzle/.keep', '')",
      "await Bun.write('dist/share/rika/inspect/inspect.js', '')",
      "await Bun.write('dist/share/rika/web/dist/index.html', '')",
    ])
    const fakeE2b = await fakeExecutable(workspace, "fake-e2b", [
      "#!/usr/bin/env bun",
      "const { appendFile } = await import('node:fs/promises')",
      `await appendFile(${JSON.stringify(log)}, "e2b " + Bun.argv.slice(2).join(" ") + "\\n")`,
      "console.log('template id: tpl_rika_orb_123')",
    ])

    try {
      const result = await runBuildScript({
        E2B_API_KEY: "test-key",
        RIKA_ORB_TEMPLATE_DIR: templateDir,
        RIKA_BUN_EXECUTABLE: fakeBun,
        RIKA_E2B_EXECUTABLE: fakeE2b,
      })
      const output = JSON.parse(result.stdout)
      const commands = await readFile(log, "utf8")

      expect(result.exitCode).toBe(0)
      expect(output.template_id).toBe("tpl_rika_orb_123")
      expect(commands).toContain("bun run package")
      expect(commands).toContain("e2b template create")
      expect(commands.indexOf("bun run package")).toBeLessThan(commands.indexOf("e2b template create"))
      expect(commands).toContain("rika-orb")
      expect(commands).toContain(templateDir)
      expect(await Bun.file(join(templateDir, ".build/rika/bin/rika")).text()).toBe("linux-binary")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("uses the project template id unless the environment overrides it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-template-"))
    const dataDir = join(workspace, ".rika")

    try {
      await createProject(dataDir, "demo", "project-orb-template")

      const projectResult = await runBuildScript({
        E2B_API_KEY: "test-key",
        RIKA_DATA_DIR: dataDir,
        RIKA_ORB_PROJECT: "demo",
        RIKA_ORB_TEMPLATE_DIR: join(workspace, "project-template-context"),
        ...(await fakeToolEnv(workspace, "project")),
      })
      const projectCommands = await readFile(join(workspace, "project-commands.log"), "utf8")

      expect(projectResult.exitCode).toBe(0)
      expect(projectCommands).toContain("e2b template create project-orb-template")

      const envResult = await runBuildScript({
        E2B_API_KEY: "test-key",
        RIKA_DATA_DIR: dataDir,
        RIKA_ORB_PROJECT: "demo",
        RIKA_ORB_TEMPLATE: "env-orb-template",
        RIKA_ORB_TEMPLATE_DIR: join(workspace, "env-template-context"),
        ...(await fakeToolEnv(workspace, "env")),
      })
      const envCommands = await readFile(join(workspace, "env-commands.log"), "utf8")

      expect(envResult.exitCode).toBe(0)
      expect(envCommands).toContain("e2b template create env-orb-template")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }, 15_000)

  test("does not read a missing project when the environment template id is set", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-template-"))

    try {
      const result = await runBuildScript({
        E2B_API_KEY: "test-key",
        RIKA_DATA_DIR: join(workspace, ".rika"),
        RIKA_ORB_PROJECT: "missing-project",
        RIKA_ORB_TEMPLATE: "env-orb-template",
        RIKA_ORB_TEMPLATE_DIR: join(workspace, "env-missing-project-template-context"),
        ...(await fakeToolEnv(workspace, "env-missing-project")),
      })
      const commands = await readFile(join(workspace, "env-missing-project-commands.log"), "utf8")

      expect(result.exitCode).toBe(0)
      expect(commands).toContain("e2b template create env-orb-template")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

const runBuildScript = async (env: Record<string, string>) => {
  const child = Bun.spawn(["bun", buildScriptPath], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: Bun.env.PATH ?? "",
      ...env,
    },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

const fakeExecutable = async (directory: string, name: string, lines: ReadonlyArray<string>) => {
  const path = join(directory, name)
  await mkdir(directory, { recursive: true })
  await writeFile(path, `${lines.join("\n")}\n`)
  await chmod(path, 0o755)
  return path
}

const fakeToolEnv = async (workspace: string, label: string) => {
  const log = join(workspace, `${label}-commands.log`)
  const fakeBun = await fakeExecutable(workspace, `${label}-fake-bun`, [
    "#!/usr/bin/env bun",
    "const { appendFile } = await import('node:fs/promises')",
    `await appendFile(${JSON.stringify(log)}, "bun " + Bun.argv.slice(2).join(" ") + "\\n")`,
    "await Bun.write('dist/release/rika-linux-x64', 'linux-binary')",
    "await Bun.write('dist/release/rika-linux-x64.json', JSON.stringify({ platform: 'linux', arch: 'x64' }))",
    "await Bun.write('dist/share/rika/drizzle/.keep', '')",
    "await Bun.write('dist/share/rika/inspect/inspect.js', '')",
    "await Bun.write('dist/share/rika/web/dist/index.html', '')",
  ])
  const fakeE2b = await fakeExecutable(workspace, `${label}-fake-e2b`, [
    "#!/usr/bin/env bun",
    "const { appendFile } = await import('node:fs/promises')",
    `await appendFile(${JSON.stringify(log)}, "e2b " + Bun.argv.slice(2).join(" ") + "\\n")`,
    "console.log('template id: tpl_rika_orb_123')",
  ])
  return {
    RIKA_BUN_EXECUTABLE: fakeBun,
    RIKA_E2B_EXECUTABLE: fakeE2b,
  }
}

const createProject = async (dataDir: string, name: string, templateId: string) => {
  const child = Bun.spawn(
    [
      "bun",
      cliMainPath,
      "project",
      "create",
      name,
      "--repo",
      "https://example.invalid/rika.git",
      "--template",
      templateId,
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...Bun.env,
        RIKA_DATA_DIR: dataDir,
        RIKA_WORKSPACE_ROOT: root,
      },
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 })
}
