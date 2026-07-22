import type { Clock, Deferred, FileSystem, Path, Ref } from "effect"
import type * as Effect from "effect/Effect"
import type { make } from "../../src/resident-client-transport"

type ResidentService = Effect.Success<ReturnType<typeof make>>
type ResidentConnection = Effect.Success<ReturnType<ResidentService["getOrCreate"]>>

export interface ResidentCommandContext {
  readonly connection: ResidentConnection
  readonly path: Path.Path
  readonly fs: FileSystem.FileSystem
  readonly dataRoot: string
  readonly emit: (value: unknown) => Effect.Effect<void>
  readonly kill: (pid: number) => Effect.Effect<void>
  readonly hostPid: Ref.Ref<number>
  readonly clock: Clock.Clock
  readonly done: Deferred.Deferred<void>
  readonly workspace: string
}
