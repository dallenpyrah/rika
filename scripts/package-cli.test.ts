import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  nonTargetOpentuiNativePackageNames,
  opentuiNativePackageName,
  platformEnginePackageName,
  platformNapiPackageName,
  requiredRivetkitSidecarPackageNames,
  resolveEnginePath,
  resolveRivetkitSidecarPackages,
} from "./package-cli"
import { installPlan } from "./install-release"

const root = new URL("..", import.meta.url).pathname
const packageScriptPath = join(root, "scripts/package-cli.ts")

describe("package CLI", () => {
  test("declares the compiled sidecar packaging contract", async () => {
    const script = await readFile(packageScriptPath, "utf8")

    expect(script).toContain('rivet_host: "dist/share/rika/rivet-host/index.js"')
    expect(script).toContain("--compile-autoload-package-json")
    expect(script).toContain("--packages bundle")
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

  test("keeps the target OpenTUI native package bundled while externalizing other platforms", () => {
    expect(opentuiNativePackageName("darwin", "arm64", undefined)).toBe("@opentui/core-darwin-arm64")
    expect(opentuiNativePackageName("linux", "x64", "bun-linux-x64-musl")).toBe("@opentui/core-linux-x64-musl")
    expect(nonTargetOpentuiNativePackageNames("darwin", "arm64", undefined)).not.toContain("@opentui/core-darwin-arm64")
    expect(nonTargetOpentuiNativePackageNames("darwin", "arm64", undefined)).toContain("@opentui/core-linux-x64")
  })

  test("local install preserves the launcher binary sidecar", () => {
    expect(
      installPlan({
        platform: "darwin",
        arch: "arm64",
        installDir: "/tmp/rika-bin",
        shareDir: "/tmp/rika-share",
        pid: 7,
      }),
    ).toMatchObject({
      source: "dist/release/rika-darwin-arm64",
      target: "/tmp/rika-bin/rika",
      compiledSource: "dist/release/rika-darwin-arm64.bin",
      compiledTarget: "/tmp/rika-bin/rika-darwin-arm64.bin",
      compiledTempTarget: "/tmp/rika-bin/rika-darwin-arm64.bin.tmp-7",
    })

    const windowsPlan = installPlan({
      platform: "win32",
      arch: "x64",
      installDir: "C:/rika/bin",
      shareDir: "C:/rika/share",
      pid: 7,
    })
    expect(windowsPlan).toMatchObject({
      source: "dist/release/rika-win32-x64.exe",
      target: "C:/rika/bin/rika.exe",
    })
    expect(windowsPlan.compiledSource).toBeUndefined()
    expect(windowsPlan.compiledTarget).toBeUndefined()
  })
})
