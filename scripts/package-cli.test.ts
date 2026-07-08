import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  platformEnginePackageName,
  platformNapiPackageName,
  requiredRivetkitSidecarPackageNames,
  resolveEnginePath,
  resolveRivetkitSidecarPackages,
} from "./package-cli"

const root = new URL("..", import.meta.url).pathname
const packageScriptPath = join(root, "scripts/package-cli.ts")

describe("package CLI", () => {
  test("declares the compiled sidecar packaging contract", async () => {
    const script = await readFile(packageScriptPath, "utf8")

    expect(script).toContain('rivet_host: "dist/share/rika/rivet-host/index.js"')
    expect(script).toContain("--compile-autoload-package-json")
  })

  test("resolves current-platform Rivet sidecar packages and engine binary", async () => {
    const packages = resolveRivetkitSidecarPackages(process.platform, process.arch, undefined)
    const packageNames = packages.map((entry) => entry.name)

    expect(packageNames).toContain("@rivetkit/rivetkit-napi")
    expect(packageNames).toContain(platformNapiPackageName(process.platform, process.arch, undefined))
    expect(packageNames).toContain("@rivetkit/engine-cli")
    expect(packageNames).toContain(platformEnginePackageName(process.platform, process.arch))
    expect(packageNames).toContain("@rivetkit/rivetkit-wasm")
    for (const entry of packages) {
      expect(await Bun.file(join(entry.directory, "package.json")).exists()).toBe(true)
    }
    expect(await Bun.file(resolveEnginePath(process.platform, process.arch)).exists()).toBe(true)
  })

  test("selects Linux NAPI sidecars by target libc and does not silently omit required packages", () => {
    expect(platformNapiPackageName("linux", "x64", "bun-linux-x64")).toBe("@rivetkit/rivetkit-napi-linux-x64-gnu")
    expect(platformNapiPackageName("linux", "x64", "bun-linux-x64-musl")).toBe("@rivetkit/rivetkit-napi-linux-x64-musl")
    expect(requiredRivetkitSidecarPackageNames("linux", "x64", "bun-linux-x64-musl")).toContain(
      "@rivetkit/engine-cli-linux-x64-musl",
    )
    expect(() => requiredRivetkitSidecarPackageNames("plan9", "x64", undefined)).toThrow(
      "Unsupported RivetKit sidecar target plan9-x64",
    )
    expect(() => resolveEnginePath("plan9", "x64")).toThrow("Unsupported Rivet engine target plan9-x64")
  })
})
