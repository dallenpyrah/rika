import { Remote } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { open, readdir, realpath, stat } from "node:fs/promises"
import { join, sep } from "node:path"

export const OrbFilesErrorKind = Schema.Literals(["invalid_path", "not_found", "not_file", "not_directory", "io"])
export type OrbFilesErrorKind = typeof OrbFilesErrorKind.Type

export class OrbFilesError extends Schema.TaggedErrorClass<OrbFilesError>()("OrbFilesError", {
  kind: OrbFilesErrorKind,
  message: Schema.String,
  operation: Schema.String,
  workspace_root: Schema.String,
  path: Schema.String,
}) {}

export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
export const ListInput = Schema.Struct({
  workspace_root: Schema.String,
  path: Schema.String,
}).annotate({ identifier: "Rika.Orb.OrbFiles.ListInput" })

export interface ReadInput extends Schema.Schema.Type<typeof ReadInput> {}
export const ReadInput = Schema.Struct({
  workspace_root: Schema.String,
  path: Schema.String,
}).annotate({ identifier: "Rika.Orb.OrbFiles.ReadInput" })

export interface Interface {
  readonly list: (input: ListInput) => Effect.Effect<Remote.OrbFilesResponse, OrbFilesError>
  readonly read: (input: ReadInput) => Effect.Effect<Remote.OrbFileResponse, OrbFilesError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/orb/OrbFiles") {}

const maxTextBytes = 1_048_576
const utf8 = new TextDecoder("utf-8", { fatal: true })

interface ResolvedPath {
  readonly workspace_real: string
  readonly path: string
  readonly absolute: string
}

const serviceLayer = Layer.succeed(
  Service,
  Service.of({
    list: Effect.fn("OrbFiles.list")(function* (input: ListInput) {
      const resolved = yield* resolveContainedPath(input, "list")
      const info = yield* statPath(resolved, "list")
      if (!info.isDirectory()) {
        return yield* fail(input, "list", "not_directory", `${resolved.path || "."} is not a directory`)
      }
      const entries = yield* Effect.tryPromise({
        try: async () => {
          const items = await readdir(resolved.absolute, { withFileTypes: true })
          const visible = items.filter((item) => !(resolved.path === "" && item.name === ".rika"))
          const resolvedEntries = await Promise.all(
            visible.map(async (item): Promise<Remote.OrbFileEntry | undefined> => {
              const path = childPath(resolved.path, item.name)
              const childAbsolute = join(resolved.absolute, item.name)
              const childReal = await realpath(childAbsolute)
              if (!isVisibleWorkspacePath(resolved.workspace_real, childReal)) return undefined
              const childInfo = await stat(childReal)
              if (!childInfo.isDirectory() && !childInfo.isFile()) return undefined
              return childInfo.isDirectory()
                ? { name: item.name, path, kind: "dir" }
                : { name: item.name, path, kind: "file", size: childInfo.size }
            }),
          )
          return resolvedEntries
            .filter((entry): entry is Remote.OrbFileEntry => entry !== undefined)
            .toSorted((left, right) => {
              if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1
              return left.name.localeCompare(right.name)
            })
        },
        catch: (cause) => toError(input, "list", "io", cause),
      })
      return { path: resolved.path, entries }
    }),
    read: Effect.fn("OrbFiles.read")(function* (input: ReadInput) {
      const resolved = yield* resolveContainedPath(input, "read")
      const info = yield* statPath(resolved, "read")
      if (!info.isFile()) return yield* fail(input, "read", "not_file", `${resolved.path} is not a file`)
      const data = yield* Effect.tryPromise({
        try: async () => {
          const handle = await open(resolved.absolute, "r")
          try {
            const bytesToRead = Math.min(info.size, maxTextBytes + 4)
            const buffer = new Uint8Array(bytesToRead)
            const result = await handle.read(buffer, 0, bytesToRead, 0)
            return buffer.subarray(0, result.bytesRead)
          } finally {
            await handle.close()
          }
        },
        catch: (cause) => toError(input, "read", "io", cause),
      })
      if (containsNul(data)) return { path: resolved.path, kind: "binary", binary: true }
      const truncated = info.size > maxTextBytes
      const decoded = decodeUtf8Prefix(data, Math.min(data.length, maxTextBytes))
      if (decoded === undefined) return { path: resolved.path, kind: "binary", binary: true }
      return { path: resolved.path, kind: "text", content: decoded, truncated }
    }),
  }),
)

export const layer = serviceLayer

export const testLayer = (implementation: Interface) => Layer.succeed(Service, Service.of(implementation))

export const list = Effect.fn("OrbFiles.list.call")(function* (input: ListInput) {
  const service = yield* Service
  return yield* service.list(input)
})

export const read = Effect.fn("OrbFiles.read.call")(function* (input: ReadInput) {
  const service = yield* Service
  return yield* service.read(input)
})

const resolveContainedPath = (
  input: ListInput | ReadInput,
  operation: string,
): Effect.Effect<ResolvedPath, OrbFilesError> =>
  Effect.gen(function* () {
    const normalized = yield* normalizePath(input, operation)
    const workspaceReal = yield* Effect.tryPromise({
      try: () => realpath(input.workspace_root),
      catch: (cause) => toError(input, operation, "io", cause),
    })
    const absolute = normalized === "" ? workspaceReal : join(workspaceReal, ...normalized.split("/"))
    const candidateReal = yield* Effect.tryPromise({
      try: () => realpath(absolute),
      catch: (cause) => toError(input, operation, "not_found", cause),
    })
    if (!isInsideWorkspace(workspaceReal, candidateReal)) {
      return yield* fail(input, operation, "invalid_path", `${input.path} escapes the workspace`)
    }
    if (isInternalRuntimePath(workspaceReal, candidateReal)) {
      return yield* fail(input, operation, "invalid_path", `${input.path} is internal`)
    }
    return { workspace_real: workspaceReal, path: normalized, absolute: candidateReal }
  })

const normalizePath = (input: ListInput | ReadInput, operation: string): Effect.Effect<string, OrbFilesError> => {
  const raw = input.path
  if (raw === "" || raw === ".") return Effect.succeed("")
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(raw)) {
    return fail(input, operation, "invalid_path", `${input.path} is not a relative workspace path`)
  }
  const segments = raw.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return fail(input, operation, "invalid_path", `${input.path} is not a relative workspace path`)
  }
  if (segments[0] === ".rika") return fail(input, operation, "invalid_path", `${input.path} is internal`)
  return Effect.succeed(segments.join("/"))
}

const statPath = (resolved: ResolvedPath, operation: string) =>
  Effect.tryPromise({
    try: () => stat(resolved.absolute),
    catch: (cause) =>
      new OrbFilesError({
        kind: "not_found",
        message: cause instanceof Error ? cause.message : String(cause),
        operation,
        workspace_root: resolved.workspace_real,
        path: resolved.path,
      }),
  })

const childPath = (parent: string, name: string) => (parent.length === 0 ? name : `${parent}/${name}`)

const isInsideWorkspace = (workspaceReal: string, candidateReal: string) =>
  candidateReal === workspaceReal || candidateReal.startsWith(`${workspaceReal}${sep}`)

const isVisibleWorkspacePath = (workspaceReal: string, candidateReal: string) =>
  isInsideWorkspace(workspaceReal, candidateReal) && !isInternalRuntimePath(workspaceReal, candidateReal)

const isInternalRuntimePath = (workspaceReal: string, candidateReal: string) => {
  const internalRoot = join(workspaceReal, ".rika")
  return candidateReal === internalRoot || candidateReal.startsWith(`${internalRoot}${sep}`)
}

const containsNul = (bytes: Uint8Array) => bytes.includes(0)

const decodeUtf8Prefix = (bytes: Uint8Array, end: number): string | undefined => {
  const minimum = Math.max(0, end - 4)
  for (let currentEnd = end; currentEnd >= minimum; currentEnd -= 1) {
    try {
      return utf8.decode(bytes.subarray(0, currentEnd))
    } catch {
      continue
    }
  }
  return undefined
}

const fail = (
  input: ListInput | ReadInput,
  operation: string,
  kind: OrbFilesErrorKind,
  message: string,
): Effect.Effect<never, OrbFilesError> =>
  Effect.fail(
    new OrbFilesError({
      kind,
      message,
      operation,
      workspace_root: input.workspace_root,
      path: input.path,
    }),
  )

const toError = (input: ListInput | ReadInput, operation: string, kind: OrbFilesErrorKind, cause: unknown) =>
  new OrbFilesError({
    kind,
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    workspace_root: input.workspace_root,
    path: input.path,
  })
