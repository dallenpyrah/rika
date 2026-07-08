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

const nativeTargets = [
  "@opentui/core-darwin-arm64",
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-win32-arm64",
  "@opentui/core-win32-x64",
]
const bundledNative = nativeTargets.filter((name) => matchesArtifactTarget(name) && isResolvable(name))
const externalNative = nativeTargets.filter((name) => !bundledNative.includes(name))
const externalFlags = externalNative.flatMap((name) => ["--external", name])
const enginePath = resolveEnginePath(artifactPlatform, artifactArch)
const packagedEnginePath =
  enginePath === undefined
    ? undefined
    : `dist/share/rika/bin/${artifactPlatform === "win32" ? "rivet-engine.exe" : "rivet-engine"}`
const rivetkitSidecarPackages = resolveRivetkitSidecarPackages(artifactPlatform, artifactArch, artifactTarget)

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
    bundled: bundledNative,
    external: externalNative,
    rivetkit_sidecar: rivetkitSidecarPackages.map((entry) => entry.name),
  },
}

if (bundledNative.length === 0) {
  console.warn(
    `[package-cli] no @opentui/core native package resolved for ${artifactPlatform}-${artifactArch}; ` +
      "the packaged binary will fail to launch the TUI. Run `bun install` on the target platform.",
  )
}

if (import.meta.main) {
  await $`mkdir -p ${outDir.pathname}`
  await $`rm -rf ${shareRoot.pathname}`
  await $`mkdir -p ${drizzleShareDir.pathname}`
  await $`cp -R ${migrationsDir.pathname}. ${drizzleShareDir.pathname}`
  await $`mkdir -p ${rivetHostShareDir.pathname}`
  await $`bun build packages/rivet-host/src/index.ts --target bun --format esm --outfile ${rivetHostEntry.pathname}`
  for (const entry of rivetkitSidecarPackages) {
    await copyPackageToSidecar(entry)
  }
  await $`mkdir -p ${engineShareDir.pathname}`
  await $`cp ${enginePath} ${engineSharePath.pathname}`
  await $`chmod 755 ${engineSharePath.pathname}`
  await $`bun build --compile --compile-autoload-package-json packages/cli/src/main.ts ${compileTargetFlags(artifactTarget)} ${externalFlags} --outfile ${artifact.pathname}`
  await Bun.write(new URL(`${artifactName}.json`, outDir), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(JSON.stringify(manifest))
}

function isResolvable(name: string): boolean {
  for (const base of [rootDir, bunNodeModulesDir]) {
    try {
      Bun.resolveSync(name, base)
      return true
    } catch {
      continue
    }
  }
  return false
}

function matchesArtifactTarget(name: string): boolean {
  if (artifactPlatform === "darwin") return name === `@opentui/core-darwin-${artifactArch}`
  if (artifactPlatform === "win32") return name === `@opentui/core-win32-${artifactArch}`
  if (artifactPlatform === "linux") return name === `@opentui/core-linux-${artifactArch}`
  return false
}

function readPackageJson(value: unknown) {
  if (typeof value !== "object" || value === null || !("version" in value)) return {}
  const version = value.version
  return typeof version === "string" ? { version } : {}
}

function compileTargetFlags(target: string | undefined) {
  return target === undefined ? [] : ["--target", target]
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
