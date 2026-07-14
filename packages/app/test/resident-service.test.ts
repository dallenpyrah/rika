import { describe, expect, it } from "vitest"
import { Cause, Crypto, Deferred, Effect, Exit, Fiber, FiberSet, Layer, Ref } from "effect"
import {
  canonicalServiceIdentity,
  makeLifecycle,
  negotiateCapabilities,
  protocolVersion,
  validateHandshake,
} from "../src/resident-service"

describe("resident service protocol", () => {
  it("uses canonical profile and data root identity", async () => {
    const crypto = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    )
    const identity = (profile: string) =>
      Effect.runPromise(canonicalServiceIdentity(profile, "/tmp/rika").pipe(Effect.provide(crypto)))
    expect(await identity("default")).toBe(await identity("default"))
    expect(await identity("other")).not.toBe(await identity("default"))
  })

  it("fails closed for token, identity, and major version mismatches", () => {
    const base = {
      family: "rika-resident" as const,
      version: protocolVersion,
      identity: "identity",
      token: "token",
      clientNonce: "nonce",
      clientKind: "run" as const,
      clientVersion: "1",
      capabilities: ["operation"] as const,
    }
    expect(validateHandshake(base, { identity: "identity", token: "token" })._tag).toBe("Accepted")
    expect(validateHandshake({ ...base, token: "wrong" }, { identity: "identity", token: "token" })._tag).toBe(
      "AuthenticationFailed",
    )
    expect(validateHandshake({ ...base, identity: "wrong" }, { identity: "identity", token: "token" })._tag).toBe(
      "IdentityMismatch",
    )
    expect(
      validateHandshake({ ...base, version: { major: 2, minor: 0 } }, { identity: "identity", token: "token" })._tag,
    ).toBe("UpgradeRequired")
  })

  it("enables a transport capability only when both peers advertise it", () => {
    expect(negotiateCapabilities(["ping", "startup-state"], ["ping", "startup-state"])).toEqual([
      "ping",
      "startup-state",
    ])
    expect(negotiateCapabilities(["ping", "startup-state"], ["ping"])).toEqual(["ping"])
    expect(negotiateCapabilities(["ping"], ["ping", "startup-state"])).toEqual(["ping"])
  })
})

describe("resident service lifecycle", () => {
  it("cancels grace when another authenticated client attaches", async () => {
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const observed = yield* Ref.make<Array<string>>([])
        const lifecycle = yield* makeLifecycle((state) => Ref.update(observed, (values) => [...values, state]))
        yield* lifecycle.tryAttach
        yield* lifecycle.ready
        yield* lifecycle.detach
        yield* lifecycle.tryAttach
        return yield* Ref.get(observed)
      }),
    )
    expect(states).toEqual(["ready", "grace", "ready"])
  })

  it("drains only after the final client grace expires", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* makeLifecycle(() => Effect.void)
        yield* lifecycle.tryAttach
        yield* lifecycle.tryAttach
        yield* lifecycle.ready
        yield* lifecycle.detach
        yield* lifecycle.expireGrace(0)
        expect(yield* lifecycle.state).toBe("ready")
        const generation = yield* lifecycle.detach
        expect(generation).toBeDefined()
        yield* lifecycle.expireGrace(generation!)
        return yield* lifecycle.state
      }),
    )
    expect(state).toBe("draining")
  })

  it("does not let a stale grace timer stop a reattached service", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* makeLifecycle(() => Effect.void)
        yield* lifecycle.tryAttach
        yield* lifecycle.ready
        const stale = yield* lifecycle.detach
        yield* lifecycle.tryAttach
        yield* lifecycle.detach
        expect(yield* lifecycle.expireGrace(stale!)).toBe(false)
        return yield* lifecycle.state
      }),
    )
    expect(state).toBe("grace")
  })

  it("never admits a client after draining starts", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* makeLifecycle(() => Effect.void)
        expect(yield* lifecycle.tryAttach).toBe(true)
        yield* lifecycle.ready
        const generation = yield* lifecycle.detach
        expect(yield* lifecycle.expireGrace(generation!)).toBe(true)
        const attached = yield* lifecycle.tryAttach
        yield* lifecycle.ready
        return { attached, state: yield* lifecycle.state }
      }),
    )
    expect(result).toEqual({ attached: false, state: "draining" })
  })

  it("begins cooperative drain monotonically", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* makeLifecycle(() => Effect.void)
        expect(yield* lifecycle.tryAttach).toBe(true)
        yield* lifecycle.ready
        yield* lifecycle.beginDrain
        yield* lifecycle.ready
        return { attached: yield* lifecycle.tryAttach, state: yield* lifecycle.state }
      }),
    )
    expect(result).toEqual({ attached: false, state: "draining" })
  })

  it("atomically rejects work once draining starts", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* makeLifecycle(() => Effect.void)
          const fibers = yield* FiberSet.make<void>()
          yield* lifecycle.ready
          yield* lifecycle.beginDrain
          const fiber = yield* lifecycle.runWork(fibers, Effect.void)
          return { admitted: fiber !== undefined, size: yield* FiberSet.size(fibers) }
        }),
      ),
    )
    expect(result).toEqual({ admitted: false, size: 0 })
  })

  it("serializes work admission with drain and lets the host interrupt accepted work", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* makeLifecycle(() => Effect.void)
          const fibers = yield* FiberSet.make<void>()
          const started = yield* Deferred.make<void>()
          const finalized = yield* Deferred.make<void>()
          yield* lifecycle.ready
          const fiber = yield* lifecycle.runWork(
            fibers,
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(finalized, undefined)),
            ),
          )
          expect(fiber).toBeDefined()
          yield* Deferred.await(started)
          yield* lifecycle.beginDrain
          yield* FiberSet.clear(fibers)
          yield* FiberSet.awaitEmpty(fibers)
          const exit = yield* Fiber.await(fiber!)
          return {
            interrupted: Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
            finalized: yield* Deferred.isDone(finalized),
            admittedAfterDrain: (yield* lifecycle.runWork(fibers, Effect.void)) !== undefined,
          }
        }),
      ),
    )
    expect(result).toEqual({ interrupted: true, finalized: true, admittedAfterDrain: false })
  })
})
