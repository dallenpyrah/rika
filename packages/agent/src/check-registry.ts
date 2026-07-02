import { Config } from "@rika/core"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import * as ToolAccess from "./tool-access"

export const Severity = Schema.Literals(["low", "medium", "high", "critical"]).annotate({
  identifier: "Rika.Agent.CheckRegistry.Severity",
})
export type Severity = typeof Severity.Type

export interface CheckSummary extends Schema.Schema.Type<typeof CheckSummary> {}
export const CheckSummary = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  severity_default: Severity,
  tools: Schema.Array(Schema.String),
  source_path: Schema.String,
  scope_path: Schema.String,
  applies_to: Schema.Array(Schema.String),
}).annotate({ identifier: "Rika.Agent.CheckRegistry.CheckSummary" })

export interface Check extends Schema.Schema.Type<typeof Check> {}
export const Check = Schema.Struct({
  summary: CheckSummary,
  instructions: Schema.String,
}).annotate({ identifier: "Rika.Agent.CheckRegistry.Check" })

export interface ChecksForFilesInput extends Schema.Schema.Type<typeof ChecksForFilesInput> {}
export const ChecksForFilesInput = Schema.Struct({
  paths: Schema.Array(Schema.String),
}).annotate({ identifier: "Rika.Agent.CheckRegistry.ChecksForFilesInput" })

export class CheckRegistryError extends Schema.TaggedErrorClass<CheckRegistryError>()("CheckRegistryError", {
  message: Schema.String,
  operation: Schema.String,
  path: Schema.optional(Schema.String),
}) {}

export interface Interface {
  readonly list: Effect.Effect<ReadonlyArray<Check>, CheckRegistryError>
  readonly checksForFiles: (input: ChecksForFilesInput) => Effect.Effect<ReadonlyArray<Check>, CheckRegistryError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/CheckRegistry") {}

export interface DirectoryEntry {
  readonly name: string
  readonly path: string
  readonly type: "file" | "directory" | "other"
}

export interface FileSystemAdapter {
  readonly readDirectory: (path: string) => Effect.Effect<ReadonlyArray<DirectoryEntry>, CheckRegistryError>
  readonly readFile: (path: string) => Effect.Effect<string, CheckRegistryError>
}

export const layerWithFileSystem = (fileSystem: FileSystemAdapter): Layer.Layer<Service, never, Config.Service> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const values = yield* config.get
      return makeService(fileSystem, values.workspace_root)
    }),
  )

export const fakeLayer = (checks: ReadonlyArray<Check>) =>
  Layer.succeed(
    Service,
    Service.of({
      list: Effect.succeed(checks),
      checksForFiles: Effect.fn("CheckRegistry.checksForFiles.fake")(function* (input: ChecksForFilesInput) {
        return checks.map((check) => ({
          ...check,
          summary: { ...check.summary, applies_to: input.paths.length === 0 ? check.summary.applies_to : input.paths },
        }))
      }),
    }),
  )

export const list = Effect.fn("CheckRegistry.list.call")(function* () {
  const registry = yield* Service
  return yield* registry.list
})

export const checksForFiles = Effect.fn("CheckRegistry.checksForFiles.call")(function* (input: ChecksForFilesInput) {
  const registry = yield* Service
  return yield* registry.checksForFiles(input)
})

const makeService = (fileSystem: FileSystemAdapter, workspaceRoot: string) =>
  Service.of({
    list: loadEffectiveChecks(fileSystem, workspaceRoot, []),
    checksForFiles: Effect.fn("CheckRegistry.checksForFiles")(function* (input: ChecksForFilesInput) {
      return yield* loadEffectiveChecks(fileSystem, workspaceRoot, input.paths)
    }),
  })

const loadEffectiveChecks = (
  fileSystem: FileSystemAdapter,
  workspaceRoot: string,
  targetPaths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    if (targetPaths.length === 0) return yield* checksInScope(fileSystem, workspaceRoot, "")

    const bySource = new Map<string, { check: Check; paths: Set<string> }>()
    for (const path of targetPaths) {
      const relativePath = normalizeWorkspacePath(workspaceRoot, path)
      if (Option.isNone(relativePath)) continue
      const effective = new Map<string, Check>()
      for (const scope of ancestorScopes(dirname(relativePath.value))) {
        for (const check of yield* checksInScope(fileSystem, workspaceRoot, scope)) {
          effective.set(check.summary.name, check)
        }
      }
      for (const check of effective.values()) {
        const existing = bySource.get(check.summary.source_path)
        if (existing === undefined) {
          bySource.set(check.summary.source_path, { check, paths: new Set([relativePath.value]) })
        } else {
          existing.paths.add(relativePath.value)
        }
      }
    }

    return [...bySource.values()]
      .map(({ check, paths: coveredPaths }) => ({
        ...check,
        summary: { ...check.summary, applies_to: [...coveredPaths].toSorted() },
      }))
      .toSorted(compareChecks)
  })

const checksInScope = (fileSystem: FileSystemAdapter, workspaceRoot: string, scopePath: string) =>
  Effect.gen(function* () {
    const checksDirectory = join(workspaceRoot, scopePath, ".agents", "checks")
    const entries = yield* fileSystem.readDirectory(checksDirectory)
    const checks = yield* Effect.forEach(
      entries.filter((entry) => entry.type === "file" && entry.name.endsWith(".md")),
      (entry) =>
        fileSystem.readFile(entry.path).pipe(
          Effect.map((content) => parseCheckFile(workspaceRoot, scopePath, entry.path, content)),
          Effect.catch(() => Effect.succeed(Option.none<Check>())),
        ),
      { concurrency: 4 },
    )
    return checks.flatMap((check) => (Option.isSome(check) ? [check.value] : [])).toSorted(compareChecks)
  })

const parseCheckFile = (workspaceRoot: string, scopePath: string, path: string, content: string) => {
  const parsed = parseFrontmatter(content)
  if (Option.isNone(parsed)) return Option.none<Check>()
  const frontmatter = parsed.value.frontmatter
  const name = stringValue(frontmatter, "name")
  if (name === undefined || name.length === 0) return Option.none<Check>()
  const severity = severityValue(frontmatter, "severity-default") ?? "medium"
  const instructions = parsed.value.body.trim()
  if (instructions.length === 0) return Option.none<Check>()
  return Option.some({
    summary: {
      name,
      ...(stringValue(frontmatter, "description") === undefined
        ? {}
        : { description: stringValue(frontmatter, "description") }),
      severity_default: severity,
      tools: normalizeToolNames(arrayValue(frontmatter, "tools")),
      source_path: slashPath(relative(workspaceRoot, path)),
      scope_path: scopePath,
      applies_to: [],
    },
    instructions,
  } satisfies Check)
}

const parseFrontmatter = (content: string) => {
  const normalized = content.replaceAll("\r\n", "\n")
  if (!normalized.startsWith("---\n")) return Option.none<{ frontmatter: Frontmatter; body: string }>()
  const end = normalized.indexOf("\n---\n", 4)
  if (end < 0) return Option.none<{ frontmatter: Frontmatter; body: string }>()
  const frontmatter = parseYamlSubset(normalized.slice(4, end))
  const body = normalized.slice(end + "\n---\n".length)
  return Option.some({ frontmatter, body })
}

type Frontmatter = Readonly<Record<string, string | ReadonlyArray<string>>>

const parseYamlSubset = (content: string): Frontmatter => {
  const values = new Map<string, string | ReadonlyArray<string>>()
  const lines = content.split("\n")
  let listKey: string | undefined
  let listValues: Array<string> = []
  const flushList = () => {
    if (listKey !== undefined) values.set(listKey, listValues)
    listKey = undefined
    listValues = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    if (listKey !== undefined && trimmed.startsWith("- ")) {
      listValues.push(unquote(trimmed.slice(2).trim()))
      continue
    }
    flushList()
    const separator = trimmed.indexOf(":")
    if (separator < 0) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    if (value.length === 0) {
      listKey = key
      listValues = []
    } else if (value.startsWith("[") && value.endsWith("]")) {
      values.set(
        key,
        value
          .slice(1, -1)
          .split(",")
          .map((item) => unquote(item.trim()))
          .filter((item) => item.length > 0),
      )
    } else {
      values.set(key, unquote(value))
    }
  }
  flushList()
  return Object.fromEntries(values)
}

const stringValue = (frontmatter: Frontmatter, key: string) => {
  const value = frontmatter[key]
  return typeof value === "string" ? value : undefined
}

const arrayValue = (frontmatter: Frontmatter, key: string) => {
  const value = frontmatter[key]
  if (Array.isArray(value)) return value
  if (typeof value === "string" && value.length > 0) return [value]
  return []
}

const severityValue = (frontmatter: Frontmatter, key: string) => {
  const value = stringValue(frontmatter, key)
  if (value === undefined) return undefined
  const decoded = Schema.decodeUnknownOption(Severity)(value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

const defaultTools = ["read", "ffgrep", "semantic_search", "ast_grep_outline"]
const readOnlyToolSet = new Set<string>(ToolAccess.readOnlyToolNames)

const normalizeToolNames = (tools: ReadonlyArray<string>) => {
  const requested = tools.length === 0 ? defaultTools : tools
  return requested
    .map(normalizeToolName)
    .filter((tool): tool is string => tool !== undefined)
    .toSorted()
}

const normalizeToolName = (tool: string) => {
  const normalized = tool.trim()
  const mapped = toolAliases[normalized] ?? toolAliases[normalized.toLowerCase()] ?? normalized
  return readOnlyToolSet.has(mapped) ? mapped : undefined
}

const toolAliases: Readonly<Record<string, string>> = {
  Read: "read",
  Grep: "ffgrep",
  Glob: "fff.glob",
  LS: "fff.directory_search",
  read_file: "read",
  grep: "ffgrep",
  glob: "fff.glob",
  ls: "fff.directory_search",
}

const liveFileSystem: FileSystemAdapter = {
  readDirectory: (path: string) =>
    Effect.tryPromise({
      try: async () => {
        const entries = await readdir(path, { withFileTypes: true })
        return entries.map((entry) => ({
          name: entry.name,
          path: join(path, entry.name),
          type: entryType(entry.isFile(), entry.isDirectory()),
        }))
      },
      catch: (cause) => toFileSystemError(cause, "readDirectory", path),
    }).pipe(
      Effect.catchTag("CheckRegistryError", (error) => (isNotFound(error) ? Effect.succeed([]) : Effect.fail(error))),
    ),
  readFile: (path: string) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => toFileSystemError(cause, "readFile", path),
    }),
}

export const layer: Layer.Layer<Service, never, Config.Service> = layerWithFileSystem(liveFileSystem)

const entryType = (isFile: boolean, isDirectory: boolean): DirectoryEntry["type"] =>
  isFile ? "file" : isDirectory ? "directory" : "other"

const normalizeWorkspacePath = (workspaceRoot: string, path: string) => {
  const absolute = resolve(workspaceRoot, path)
  const relativePath = slashPath(relative(workspaceRoot, absolute))
  if (relativePath.startsWith("../") || relativePath === "..") return Option.none<string>()
  return Option.some(relativePath)
}

const ancestorScopes = (relativeDirectory: string) => {
  if (relativeDirectory === "." || relativeDirectory.length === 0) return [""]
  const parts = slashPath(relativeDirectory).split("/").filter(Boolean)
  const scopes = [""]
  for (let index = 0; index < parts.length; index += 1) {
    scopes.push(parts.slice(0, index + 1).join("/"))
  }
  return scopes
}

const compareChecks = (left: Check, right: Check) =>
  left.summary.scope_path.localeCompare(right.summary.scope_path) || left.summary.name.localeCompare(right.summary.name)

const unquote = (value: string) => value.replace(/^['"]|['"]$/g, "")
const slashPath = (path: string) => path.split(sep).join("/")

const toFileSystemError = (cause: unknown, operation: string, path: string) =>
  new CheckRegistryError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    path,
  })

const isNotFound = (error: CheckRegistryError) => error.message.includes("ENOENT")
