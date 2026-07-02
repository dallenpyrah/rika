import { $ } from "bun"

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
  },
  native: {
    bundled: bundledNative,
    external: externalNative,
  },
}

if (bundledNative.length === 0) {
  console.warn(
    `[package-cli] no @opentui/core native package resolved for ${artifactPlatform}-${artifactArch}; ` +
      "the packaged binary will fail to launch the TUI. Run `bun install` on the target platform.",
  )
}

await $`mkdir -p ${outDir.pathname}`
await $`rm -rf ${shareRoot.pathname}`
await $`mkdir -p ${drizzleShareDir.pathname}`
await $`cp -R ${migrationsDir.pathname}. ${drizzleShareDir.pathname}`
await $`bun build --compile packages/cli/src/main.ts ${compileTargetFlags(artifactTarget)} ${externalFlags} --outfile ${artifact.pathname}`
await Bun.write(new URL(`${artifactName}.json`, outDir), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(JSON.stringify(manifest))

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
