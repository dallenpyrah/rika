import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Crypto, Effect, FileSystem, Layer, Logger, Path, Schema } from "effect"

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)

const program = Effect.gen(function* () {
  const dataRoot = yield* Config.string("RIKA_TEST_RESIDENT_DATA_ROOT")
  const expectedClose = Number(yield* Config.string("RIKA_TEST_V3_EXPECT_CLOSE").pipe(Config.withDefault("4406")))
  const tamper = yield* Config.string("RIKA_TEST_V3_TAMPER").pipe(Config.withDefault("none"))
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const canonicalDataRoot = yield* fs.realPath(dataRoot)
  const identity = new Bun.CryptoHasher("sha256").update(`default\0${canonicalDataRoot}`).digest("hex")
  const port = 20_000 + (Number.parseInt(identity.slice(0, 8), 16) % 30_000)
  const url = `ws://127.0.0.1:${port}/resident`
  const token = (yield* fs.readFileString(path.join(canonicalDataRoot, "resident.token"))).trim()
  const crypto = yield* Crypto.Crypto
  const clientNonce = yield* crypto.randomUUIDv4
  const handshake = {
    identity,
    clientNonce,
    clientKind: "interactive",
    protocolVersion: 3,
    buildIdentity: "rika-frozen-v3-build",
  }
  const clientProof = new Bun.CryptoHasher("sha256", token)
    .update(
      encodeJson([
        "rika-resident-client",
        handshake.protocolVersion,
        handshake.identity,
        handshake.clientNonce,
        handshake.clientKind,
        handshake.buildIdentity,
      ]),
    )
    .digest("hex")
  const sent = {
    ...handshake,
    ...(tamper === "nonce" ? { clientNonce: `${clientNonce}-tampered` } : {}),
    ...(tamper === "build" ? { buildIdentity: "rika-tampered-v3-build" } : {}),
    ...(tamper === "kind" ? { clientKind: "run" } : {}),
  }
  const closeCode = yield* Effect.callback<number>((resume) => {
    const socket = new WebSocket(url)
    socket.addEventListener("open", () =>
      socket.send(
        encodeJson({
          family: "rika-resident",
          ...sent,
          clientProof: tamper === "proof" ? "0".repeat(64) : clientProof,
        }),
      ),
    )
    socket.addEventListener("message", () => resume(Effect.succeed(0)))
    socket.addEventListener("close", (event) => resume(Effect.succeed(event.code)))
    socket.addEventListener("error", () => resume(Effect.succeed(1)))
    return Effect.sync(() => socket.close())
  })
  let eventType = "legacy-close"
  if (closeCode === 4406) eventType = "legacy-restart-required"
  else if (closeCode === 0) eventType = "legacy-unexpected-attach"
  process.stdout.write(
    `${encodeJson({
      type: eventType,
      callbacks: closeCode,
    })}\n`,
  )
  if (closeCode !== expectedClose) return yield* Effect.die(`unexpected legacy close ${closeCode}`)
})

BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.mergeAll(BunServices.layer, BunCrypto.layer, Logger.layer([])))
      yield* Effect.provide(program, context)
    }),
  ),
)
