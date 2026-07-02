import { chmod, copyFile, cp, mkdir, readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Config, IdGenerator, Time } from "@rika/core"
import { Database, Migration, ProjectStore } from "@rika/persistence"
import { Effect, Layer } from "effect"

const root = new URL("..", import.meta.url).pathname
const defaultTemplateDir = join(root, "infra/orb-template")
const artifactName = "rika-linux-x64"
const artifactPath = join(root, "dist/release", artifactName)
const manifestPath = join(root, "dist/release", `${artifactName}.json`)
const sharePath = join(root, "dist/share/rika")
const requiredEnv = "E2B_API_KEY"

export interface Env {
  readonly [key: string]: string | undefined
}

export interface PackageManifest {
  readonly platform?: unknown
  readonly arch?: unknown
}

export interface BuildResult {
  readonly template_name: string
  readonly template_id: string
  readonly command: ReadonlyArray<string>
  readonly context: string
}

export const resolveOrbTemplateId = (projectTemplateId: string | undefined, env: Env = Bun.env): string => {
  const configured = env.RIKA_ORB_TEMPLATE?.trim()
  if (configured !== undefined && configured.length > 0) return configured
  const project = projectTemplateId?.trim()
  if (project !== undefined && project.length > 0) return project
  return "rika-orb"
}

export const validateOrbPackageManifest = (manifest: PackageManifest): void => {
  if (manifest.platform !== "linux" || manifest.arch !== "x64") {
    throw new Error("Orb template requires a linux-x64 Rika package artifact")
  }
}

export const e2bTemplateArgs = (templateName: string, templateDir: string): ReadonlyArray<string> => [
  "template",
  "create",
  templateName,
  "--path",
  templateDir,
  "--dockerfile",
  "e2b.Dockerfile",
  "--cpu-count",
  "2",
  "--memory-mb",
  "2048",
]

export async function buildOrbTemplate(env: Env = Bun.env): Promise<BuildResult> {
  if (env[requiredEnv]?.trim() === undefined || env[requiredEnv]?.trim() === "") {
    throw new Error(`${requiredEnv} is required to build the E2B orb template`)
  }

  const templateName = resolveOrbTemplateId(
    templateIdRequiresProjectLookup(env) ? await readProjectTemplateId(env) : undefined,
    env,
  )
  const templateDir = await prepareOrbTemplateContext(env)
  const e2bExecutable = env.RIKA_E2B_EXECUTABLE ?? "e2b"

  const args = e2bTemplateArgs(templateName, templateDir)
  const e2b = await run(e2bExecutable, args, root, env)
  const templateId = parseTemplateId(e2b.stdout) ?? templateName
  return {
    template_name: templateName,
    template_id: templateId,
    command: [e2bExecutable, ...args],
    context: templateDir,
  }
}

export async function prepareOrbTemplateContext(env: Env = Bun.env): Promise<string> {
  const templateDir = env.RIKA_ORB_TEMPLATE_DIR ?? defaultTemplateDir
  const bunExecutable = env.RIKA_BUN_EXECUTABLE ?? "bun"

  await run(bunExecutable, ["run", "package"], root, {
    ...env,
    RIKA_PACKAGE_TARGET: "bun-linux-x64",
    RIKA_PACKAGE_PLATFORM: "linux",
    RIKA_PACKAGE_ARCH: "x64",
  })

  const manifest = parsePackageManifest(await readFile(manifestPath, "utf8"))
  validateOrbPackageManifest(manifest)
  await prepareTemplateContext(templateDir)
  return templateDir
}

export async function readProjectTemplateId(env: Env = Bun.env): Promise<string | undefined> {
  const name = env.RIKA_ORB_PROJECT?.trim()
  if (name === undefined || name.length === 0) return undefined

  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? root
  const dataDir = env.RIKA_DATA_DIR ?? join(workspaceRoot, ".rika")
  const configLayer = Config.layerFromValues(
    {
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      default_mode: "smart",
      ...(env.RIKA_DATABASE_URL === undefined ? {} : { database_url: env.RIKA_DATABASE_URL }),
    },
    env,
  )
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const projectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(IdGenerator.layer),
  )
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    Migration.layer,
    timeLayer,
    IdGenerator.layer,
    projectStoreLayer,
  )
  const migratedLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const project = await Effect.runPromise(ProjectStore.getByName(name).pipe(Effect.provide(migratedLayer)))
  if (project === undefined) throw new Error(`Project ${name} not found`)
  return project.template_id ?? undefined
}

const templateIdRequiresProjectLookup = (env: Env): boolean => {
  const configured = env.RIKA_ORB_TEMPLATE?.trim()
  return configured === undefined || configured.length === 0
}

const prepareTemplateContext = async (templateDir: string) => {
  const buildRoot = join(templateDir, ".build/rika")
  const binDir = join(buildRoot, "bin")
  const shareDir = join(buildRoot, "share")
  await rm(join(templateDir, ".build"), { recursive: true, force: true })
  await mkdir(binDir, { recursive: true })
  await mkdir(shareDir, { recursive: true })
  await copyFile(artifactPath, join(binDir, "rika"))
  await chmod(join(binDir, "rika"), 0o755)
  await cp(sharePath, shareDir, { recursive: true })
}

const parsePackageManifest = (content: string): PackageManifest => {
  const value: unknown = JSON.parse(content)
  return isRecord(value) ? { platform: value.platform, arch: value.arch } : {}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseTemplateId = (output: string) => {
  const match = output.match(/template(?:\s|-|_)*id\s*:?\s*([A-Za-z0-9_-]+)/i)
  return match?.[1]
}

const run = async (command: string, args: ReadonlyArray<string>, cwd: string, env: Env) => {
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
  return { stdout, stderr, exitCode }
}

const definedEnv = (env: Env) => {
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) output[key] = value
  }
  return output
}

if (import.meta.main) {
  try {
    const result = await buildOrbTemplate(Bun.env)
    await mkdir(dirname(manifestPath), { recursive: true })
    console.log(JSON.stringify(result))
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exit(1)
  }
}
