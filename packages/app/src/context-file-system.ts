import { Context, Effect, FileSystem, Layer, Path, PlatformError } from "effect"

export interface Interface {
  readonly exists: (path: string) => Effect.Effect<boolean, PlatformError.PlatformError>
  readonly readDirectory: (path: string) => Effect.Effect<ReadonlyArray<string> | undefined>
  readonly readFileString: (path: string) => Effect.Effect<string, PlatformError.PlatformError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/app/context/FileSystem") {}

export const liveLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    return Service.of({
      exists: Effect.fn("ContextFileSystem.exists")((path) => fileSystem.exists(path)),
      readDirectory: Effect.fn("ContextFileSystem.readDirectory")((path) =>
        fileSystem.readDirectory(path).pipe(
          Effect.map((entries): ReadonlyArray<string> | undefined => entries),
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      ),
      readFileString: Effect.fn("ContextFileSystem.readFileString")((path) => fileSystem.readFileString(path)),
    })
  }),
)

export const testLayer = (
  files: Readonly<Record<string, string>>,
  directories: Readonly<Record<string, ReadonlyArray<string>>>,
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const path = yield* Path.Path
      const normalized = new Map(Object.entries(files).map(([name, content]) => [path.resolve(name), content]))
      const listed = new Map(Object.entries(directories).map(([name, entries]) => [path.resolve(name), entries]))
      return Service.of({
        exists: (name) => Effect.succeed(normalized.has(path.resolve(name)) || listed.has(path.resolve(name))),
        readDirectory: (name) => Effect.succeed(listed.get(path.resolve(name))),
        readFileString: (name) => {
          const content = normalized.get(path.resolve(name))
          return content === undefined ? Effect.die(`Missing test file: ${name}`) : Effect.succeed(content)
        },
      })
    }),
  )
