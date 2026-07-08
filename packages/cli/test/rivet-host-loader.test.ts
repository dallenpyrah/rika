import { describe, expect, test } from "bun:test"
import { loadRivetHostModule } from "../src/rivet-host-loader.js"

describe("rivet host loader", () => {
  test("resolves packaged sidecar paths beside installed share assets", async () => {
    const loader = await import("../src/rivet-host-loader.js")

    expect(loader.installedRivetHostEntryPath("/opt/rika/bin/rika")).toBe("/opt/rika/share/rika/rivet-host/index.js")
    expect(loader.isCompiledBinary()).toBe(false)
    expect(typeof loadRivetHostModule).toBe("function")
  })
})
