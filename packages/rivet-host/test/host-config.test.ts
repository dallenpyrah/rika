import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HostConfig } from "../src/index"

describe("HostConfig", () => {
  test("defaults to a local Rivet engine endpoint", async () => {
    const host = await Effect.runPromise(HostConfig.resolveOptions({}, {}))

    expect(host).toEqual({
      mode: "local",
      endpoint: "http://127.0.0.1:6420",
      no_welcome: true,
    })
    expect(HostConfig.toRegistryOptions(host)).toEqual({
      endpoint: "http://127.0.0.1:6420",
      noWelcome: true,
    })
  })

  test("resolves an explicit local endpoint override", async () => {
    const host = await Effect.runPromise(
      HostConfig.resolveOptions(
        {},
        {
          RIKA_RIVET_ENDPOINT: "http://localhost:7000",
        },
      ),
    )

    expect(host).toEqual({
      mode: "local",
      endpoint: "http://localhost:7000",
      no_welcome: true,
    })
    expect(HostConfig.toClientOptions(host)).toEqual({
      endpoint: "http://localhost:7000",
    })
  })

  test("parses no-welcome through the shared boolean env set", async () => {
    const host = await Effect.runPromise(HostConfig.resolveOptions({}, { RIKA_RIVET_NO_WELCOME: "disabled" }))

    expect(host.no_welcome).toBe(false)
  })

  test("rejects non-local endpoints", async () => {
    const error = await Effect.runPromise(
      HostConfig.resolveOptions({}, { RIKA_RIVET_ENDPOINT: "https://rivet.example.com" }).pipe(Effect.flip),
    )

    expect(error).toMatchObject({ key: "RIKA_RIVET_ENDPOINT" })
  })

  test("rejects all-interface bind addresses", async () => {
    const error = await Effect.runPromise(
      HostConfig.resolveOptions({}, { RIKA_RIVET_ENDPOINT: "http://0.0.0.0:6420" }).pipe(Effect.flip),
    )

    expect(error).toMatchObject({ key: "RIKA_RIVET_ENDPOINT" })
  })
})
