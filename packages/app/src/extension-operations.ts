import { McpConfig, McpOAuth, SkillRegistry } from "@rika/extensions"
import { Console, Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import type * as Operation from "./operation"

export interface Options {
  readonly globalRoot: string
  readonly workspaceRoot: string
  readonly configPath: string
  readonly trustPath: string
  readonly generationsPath: string
}

export class Error extends Schema.TaggedErrorClass<Error>()("@rika/app/ExtensionOperationError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly options: Options
}

export class Service extends Context.Service<Service, Interface>()("@rika/app/ExtensionOperations") {}

export const layer = (options: Options) => Layer.succeed(Service, Service.of({ options }))

const readDocument = (fileSystem: FileSystem.FileSystem, filename: string) =>
  fileSystem.exists(filename).pipe(
    Effect.flatMap((exists) => (exists ? fileSystem.readFileString(filename) : Effect.succeed("{}"))),
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as Record<string, unknown>,
        catch: (cause) => new Error({ message: String(cause) }),
      }),
    ),
    Effect.mapError((cause) => (cause instanceof Error ? cause : new Error({ message: String(cause) }))),
  )

const writeDocument = (fileSystem: FileSystem.FileSystem, path: Path.Path, filename: string, value: unknown) =>
  fileSystem.makeDirectory(path.dirname(filename), { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFileString(filename, `${JSON.stringify(value, undefined, 2)}\n`)),
    Effect.mapError((cause) => new Error({ message: String(cause) })),
  )

export const run = Effect.fn("ExtensionOperations.run")(function* (
  input: Extract<Operation.Input, { readonly _tag: "Skill" | "Mcp" | "Extension" }>,
) {
  const service = yield* Service
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (input._tag === "Skill") {
    if (input.action === "list") {
      const discovered = yield* SkillRegistry.discover({
        globalRoot: service.options.globalRoot,
        workspaceRoot: service.options.workspaceRoot,
      }).pipe(Effect.mapError((cause) => new Error({ message: cause.message })))
      yield* Console.log(JSON.stringify(discovered.listings))
      return
    }
    if (input.action === "inspect") {
      const discovered = yield* SkillRegistry.discover({
        globalRoot: service.options.globalRoot,
        workspaceRoot: service.options.workspaceRoot,
      }).pipe(Effect.mapError((cause) => new Error({ message: cause.message })))
      yield* Console.log(
        JSON.stringify(
          yield* discovered
            .activate(input.name)
            .pipe(Effect.mapError((cause) => new Error({ message: cause.message }))),
        ),
      )
      return
    }
    if (input.action === "remove") {
      yield* fileSystem
        .remove(path.join(service.options.workspaceRoot, input.name), { recursive: true })
        .pipe(Effect.mapError((cause) => new Error({ message: String(cause) })))
    } else if ("source" in input) {
      yield* fileSystem
        .copy(input.source, path.join(service.options.workspaceRoot, path.basename(input.source)), { overwrite: false })
        .pipe(Effect.mapError((cause) => new Error({ message: String(cause) })))
    }
    return
  }
  if (input._tag === "Mcp") {
    const document = yield* readDocument(fileSystem, service.options.configPath)
    const servers =
      typeof document.servers === "object" && document.servers !== null
        ? { ...(document.servers as Record<string, unknown>) }
        : {}
    if (input.action === "oauth-login" || input.action === "oauth-logout" || input.action === "oauth-status") {
      const oauth = yield* McpOAuth.Service
      const configured = yield* McpConfig.compose({ workspace: JSON.stringify({ servers }) }).pipe(
        Effect.mapError((cause) => new Error({ message: cause.message })),
      )
      const remote = configured.filter((server) => server.kind === "remote")
      const name = input.name
      const selected =
        input.action === "oauth-status" && name === undefined ? remote : remote.filter((server) => server.name === name)
      if (selected.length === 0 && name !== undefined)
        return yield* new Error({ message: `Remote MCP server not found: ${name}` })
      if (input.action === "oauth-login")
        yield* oauth
          .login(input.name, selected[0]!.url)
          .pipe(Effect.mapError((cause) => new Error({ message: cause.message })))
      if (input.action === "oauth-logout")
        yield* oauth
          .logout(input.name, selected[0]!.url)
          .pipe(Effect.mapError((cause) => new Error({ message: cause.message })))
      if (input.action === "oauth-status") {
        const statuses = yield* Effect.forEach(selected, (server) =>
          oauth.status(server.name, server.url).pipe(Effect.map((status) => ({ name: server.name, status }))),
        ).pipe(Effect.mapError((cause) => new Error({ message: cause.message })))
        yield* Console.log(JSON.stringify(statuses))
      }
      return
    }
    if (input.action === "list" || input.action === "doctor") {
      const composed = yield* McpConfig.compose({ workspace: JSON.stringify({ servers }) }).pipe(
        Effect.mapError((cause) => new Error({ message: cause.message })),
      )
      yield* Console.log(
        JSON.stringify(
          composed.map((server) => ({
            name: server.name,
            kind: server.kind,
            source: server.source,
            enabled: !((document.disabled as Array<string> | undefined) ?? []).includes(server.name),
          })),
        ),
      )
      return
    }
    if (input.action === "approve") {
      const approved = new Set(
        ((yield* readDocument(fileSystem, service.options.trustPath)).approved as Array<string> | undefined) ?? [],
      )
      approved.add(`${input.workspace ?? service.options.workspaceRoot}:${input.name}`)
      yield* writeDocument(fileSystem, path, service.options.trustPath, { approved: [...approved].toSorted() })
      return
    }
    if (input.action === "add")
      servers[input.name] =
        "url" in input ? { url: input.url } : { command: input.command[0], args: input.command.slice(1) }
    if (input.action === "remove") delete servers[input.name]
    const disabled = new Set((document.disabled as Array<string> | undefined) ?? [])
    if (input.action === "enable") disabled.delete(input.name)
    if (input.action === "disable") disabled.add(input.name)
    yield* writeDocument(fileSystem, path, service.options.configPath, {
      ...document,
      servers,
      disabled: [...disabled].toSorted(),
    })
    return
  }
  const state = yield* readDocument(fileSystem, service.options.generationsPath)
  const extensions = {
    ...(state.extensions as Record<string, { enabled: boolean; generation: number }> | undefined),
  }
  if (input.action === "list") {
    yield* Console.log(JSON.stringify(extensions))
    return
  }
  const current = extensions[input.name] ?? { enabled: false, generation: 1 }
  if (input.action === "enable") extensions[input.name] = { ...current, enabled: true }
  if (input.action === "disable") extensions[input.name] = { ...current, enabled: false }
  if (input.action === "rollback")
    extensions[input.name] = { ...current, generation: Math.max(1, current.generation - 1) }
  if (input.action === "create-skill" || input.action === "create-plugin")
    return yield* new Error({ message: `${input.action} is outside extension lifecycle behavior` })
  yield* writeDocument(fileSystem, path, service.options.generationsPath, { extensions })
})
