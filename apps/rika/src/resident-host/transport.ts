import * as ResidentService from "@rika/app/resident-service"
import { Config, Deferred, Effect, FileSystem } from "effect"
import { readOrCreateToken, resolve } from "../resident-endpoint"
import { releaseAdoptedStartup } from "../resident-startup"
import { defaultOutboundCapacity } from "../resident-wire"
import { host } from "./lifecycle"

export const serve = Effect.fn("ResidentTransport.serve")(function* (options: {
  readonly profile: string
  readonly dataRoot: string
  readonly graceMilliseconds?: number
  readonly ownerDrainMilliseconds?: number
  readonly startupHoldMilliseconds?: number
  readonly outboundCapacity?: number
  readonly onReady?: Effect.Effect<void, ResidentService.ResidentServiceError, FileSystem.FileSystem>
  readonly owner: ResidentService.Owner
}) {
  const endpoint = yield* resolve(options.profile, options.dataRoot)
  const token = yield* readOrCreateToken(endpoint.tokenPath)
  const ownerDrainMilliseconds =
    options.ownerDrainMilliseconds ??
    Number(yield* Config.string("RIKA_INTERNAL_RESIDENT_OWNER_DRAIN").pipe(Config.withDefault("5000")))
  const stopped = yield* Deferred.make<void>()
  const ready = yield* Deferred.make<void>()
  yield* Effect.forkChild(
    Deferred.await(ready).pipe(
      Effect.andThen(releaseAdoptedStartup(endpoint.startupPath, endpoint.identity, process.pid)),
    ),
  )
  yield* host({
    ...endpoint,
    token,
    graceMilliseconds: options.graceMilliseconds ?? 500,
    ownerDrainMilliseconds,
    startupHoldMilliseconds: options.startupHoldMilliseconds ?? 10_000,
    outboundCapacity: Math.max(1, Math.floor(options.outboundCapacity ?? defaultOutboundCapacity)),
    stopped,
    ready,
    onReady: options.onReady ?? Effect.void,
    owner: options.owner,
  }).pipe(Effect.ensuring(releaseAdoptedStartup(endpoint.startupPath, endpoint.identity, process.pid)))
})
