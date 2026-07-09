import { $ } from "bun"
import { existsSync } from "node:fs"
import { dirname } from "node:path"

const root = new URL("..", import.meta.url)
const rootDir = root.pathname
const bunNodeModulesDir = new URL("node_modules/.bun/node_modules/", root).pathname
const packageJson = readPackageJson(await Bun.file(new URL("package.json", root)).json())
const artifactPlatform = Bun.env.RIKA_PACKAGE_PLATFORM ?? process.platform
const artifactArch = Bun.env.RIKA_PACKAGE_ARCH ?? process.arch
const artifactTarget = Bun.env.RIKA_PACKAGE_TARGET
const artifactName = `rika-${artifactPlatform}-${artifactArch}${artifactPlatform === "win32" ? ".exe" : ""}`
const outDir = new URL("dist/release/", root)
const shareRoot = new URL("dist/share/rika/", root)
const drizzleShareDir = new URL("drizzle/", shareRoot)
const engineShareDir = new URL("bin/", shareRoot)
const engineSharePath = new URL(artifactPlatform === "win32" ? "rivet-engine.exe" : "rivet-engine", engineShareDir)
const rivetHostShareDir = new URL("rivet-host/", shareRoot)
const rivetHostEntry = new URL("index.js", rivetHostShareDir)
const rivetHostNodeModulesDir = new URL("node_modules/", rivetHostShareDir)
const migrationsDir = new URL("packages/persistence/drizzle/", root)
const artifact = new URL(artifactName, outDir)
const compiledArtifact = artifactPlatform === "win32" ? artifact : new URL(`${artifactName}.bin`, outDir)

const enginePath = resolveEnginePath(artifactPlatform, artifactArch)
const packagedEnginePath =
  enginePath === undefined
    ? undefined
    : `dist/share/rika/bin/${artifactPlatform === "win32" ? "rivet-engine.exe" : "rivet-engine"}`
const rivetkitSidecarPackages = resolveRivetkitSidecarPackages(artifactPlatform, artifactArch, artifactTarget)
const opentuiExternalFlags = nonTargetOpentuiNativePackageNames(artifactPlatform, artifactArch, artifactTarget).flatMap(
  (name) => ["--external", name],
)

const manifest = {
  name: "rika",
  version: packageJson.version ?? "0.0.0",
  bun_version: Bun.version,
  platform: artifactPlatform,
  arch: artifactArch,
  ...(artifactTarget === undefined ? {} : { target: artifactTarget }),
  entrypoint: "packages/cli/src/main.ts",
  artifact: `dist/release/${artifactName}`,
  share: {
    drizzle: "dist/share/rika/drizzle",
    rivet_host: "dist/share/rika/rivet-host/index.js",
    ...(packagedEnginePath === undefined ? {} : { engine: packagedEnginePath }),
  },
  native: {
    rivetkit_sidecar: rivetkitSidecarPackages.map((entry) => entry.name),
  },
}

if (import.meta.main) {
  await $`mkdir -p ${outDir.pathname}`
  await $`rm -rf ${shareRoot.pathname}`
  await $`mkdir -p ${drizzleShareDir.pathname}`
  await $`cp -R ${migrationsDir.pathname}. ${drizzleShareDir.pathname}`
  await $`mkdir -p ${rivetHostShareDir.pathname}`
  await $`bun build packages/rivet-host/src/index.ts --target bun --format esm --outfile ${rivetHostEntry.pathname} --packages bundle`
  for (const entry of rivetkitSidecarPackages) {
    await copyPackageToSidecar(entry)
  }
  await $`mkdir -p ${engineShareDir.pathname}`
  await $`cp ${enginePath} ${engineSharePath.pathname}`
  await $`chmod 755 ${engineSharePath.pathname}`
  await $`bun build --compile --compile-autoload-package-json packages/cli/src/main.ts ${compileTargetFlags(artifactTarget)} ${opentuiExternalFlags} --outfile ${compiledArtifact.pathname}`
  if (artifactPlatform !== "win32") {
    await Bun.write(artifact, unixLauncher(artifactName))
    await $`chmod 755 ${artifact.pathname}`
  }
  await Bun.write(new URL(`${artifactName}.json`, outDir), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(JSON.stringify(manifest))
}

function readPackageJson(value: unknown) {
  if (typeof value !== "object" || value === null || !("version" in value)) return {}
  const version = value.version
  return typeof version === "string" ? { version } : {}
}

function compileTargetFlags(target: string | undefined) {
  return target === undefined ? [] : ["--target", target]
}

function unixLauncher(name: string) {
  return `#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SHARE_DIR="$SCRIPT_DIR/../share/rika"
if [ -z "\${RIKA_DATA_DIR:-}" ]; then
  RIKA_DATA_DIR="\${HOME:-.}/.rika"
  export RIKA_DATA_DIR
fi
if [ -z "\${RIVET_LOG_LEVEL:-}" ]; then
  RIVET_LOG_LEVEL="silent"
  export RIVET_LOG_LEVEL
fi
if [ -z "\${RIVETKIT_STORAGE_PATH:-}" ]; then
  RIVETKIT_STORAGE_PATH="$RIKA_DATA_DIR/rivetkit"
  export RIVETKIT_STORAGE_PATH
fi
if [ -z "\${RIVET_ENGINE_BINARY:-}" ] && [ -x "$SHARE_DIR/bin/rivet-engine" ]; then
  RIVET_ENGINE_BINARY="$SHARE_DIR/bin/rivet-engine"
  export RIVET_ENGINE_BINARY
fi
if [ -d "$SHARE_DIR/rivet-host/node_modules" ]; then
  NODE_PATH="$SHARE_DIR/rivet-host/node_modules\${NODE_PATH:+:$NODE_PATH}"
  export NODE_PATH
fi
exec "$SCRIPT_DIR/${name}.bin" "$@"
`
}

export function resolveEnginePath(platform: string, arch: string): string {
  const packageName = platformEnginePackageName(platform, arch)
  if (packageName === undefined) throw new Error(`Unsupported Rivet engine target ${platform}-${arch}`)
  const packageDirectory = resolvePackageDirectory(packageName)
  if (packageDirectory === undefined) {
    throw new Error(`Missing required Rivet engine package ${packageName} for ${platform}-${arch}`)
  }
  const path = `${packageDirectory}/${platform === "win32" ? "rivet-engine.exe" : "rivet-engine"}`
  if (!existsSync(path)) {
    throw new Error(`Missing Rivet engine binary ${path}`)
  }
  return path
}

export function requiredRivetkitSidecarPackageNames(
  platform: string,
  arch: string,
  target: string | undefined,
): ReadonlyArray<string> {
  const napiPackage = platformNapiPackageName(platform, arch, target)
  const enginePackage = platformEnginePackageName(platform, arch)
  if (napiPackage === undefined || enginePackage === undefined) {
    throw new Error(`Unsupported RivetKit sidecar target ${platform}-${arch}`)
  }
  const names = [
    "@rivetkit/rivetkit-napi",
    napiPackage,
    "@rivetkit/engine-cli",
    enginePackage,
    "@rivetkit/rivetkit-wasm",
  ]
  return names
}

export function resolveRivetkitSidecarPackages(
  platform: string,
  arch: string,
  target: string | undefined,
): ReadonlyArray<{ readonly name: string; readonly directory: string }> {
  return requiredRivetkitSidecarPackageNames(platform, arch, target).map((name) => {
    const directory = resolvePackageDirectory(name)
    if (directory === undefined) {
      throw new Error(`Missing required RivetKit sidecar package ${name} for ${platform}-${arch}`)
    }
    return { name, directory }
  })
}

export function platformEnginePackageName(platform: string, arch: string): string | undefined {
  if (platform === "darwin") return `@rivetkit/engine-cli-darwin-${arch}`
  if (platform === "linux") return `@rivetkit/engine-cli-linux-${arch}-musl`
  if (platform === "win32" && arch === "x64") return "@rivetkit/engine-cli-win32-x64"
  return undefined
}

export function platformNapiPackageName(
  platform: string,
  arch: string,
  target: string | undefined,
): string | undefined {
  if (platform === "darwin") return `@rivetkit/rivetkit-napi-darwin-${arch}`
  if (platform === "linux") return `@rivetkit/rivetkit-napi-linux-${arch}-${target?.includes("musl") ? "musl" : "gnu"}`
  if (platform === "win32" && arch === "x64") return "@rivetkit/rivetkit-napi-win32-x64-msvc"
  return undefined
}

export function opentuiNativePackageName(
  platform: string,
  arch: string,
  target: string | undefined,
): string | undefined {
  if (platform === "darwin") return `@opentui/core-darwin-${arch}`
  if (platform === "linux") return `@opentui/core-linux-${arch}${target?.includes("musl") ? "-musl" : ""}`
  if (platform === "win32") return `@opentui/core-win32-${arch}`
  return undefined
}

export function opentuiNativePackageNames(): ReadonlyArray<string> {
  return [
    "@opentui/core-darwin-arm64",
    "@opentui/core-darwin-x64",
    "@opentui/core-linux-arm64",
    "@opentui/core-linux-arm64-musl",
    "@opentui/core-linux-x64",
    "@opentui/core-linux-x64-musl",
    "@opentui/core-win32-arm64",
    "@opentui/core-win32-x64",
  ]
}

export function nonTargetOpentuiNativePackageNames(
  platform: string,
  arch: string,
  target: string | undefined,
): ReadonlyArray<string> {
  const targetPackage = opentuiNativePackageName(platform, arch, target)
  return opentuiNativePackageNames().filter((name) => name !== targetPackage)
}

export function resolvePackageDirectory(name: string): string | undefined {
  for (const base of [rootDir, bunNodeModulesDir]) {
    try {
      return dirname(Bun.resolveSync(`${name}/package.json`, base))
    } catch {
      continue
    }
  }
  return undefined
}

async function copyPackageToSidecar(entry: { readonly name: string; readonly directory: string }) {
  const destination = new URL(`${entry.name}/`, rivetHostNodeModulesDir).pathname
  await $`mkdir -p ${dirname(destination)}`
  await $`cp -R ${entry.directory} ${destination}`
}
