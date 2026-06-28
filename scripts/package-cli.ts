import { $ } from "bun"

const root = new URL("..", import.meta.url)
const packageJson = readPackageJson(await Bun.file(new URL("package.json", root)).json())
const artifactName = `rika-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`
const outDir = new URL("dist/release/", root)
const artifact = new URL(artifactName, outDir)
const manifest = {
  name: "rika",
  version: packageJson.version ?? "0.0.0",
  bun_version: Bun.version,
  platform: process.platform,
  arch: process.arch,
  entrypoint: "packages/cli/src/main.ts",
  artifact: `dist/release/${artifactName}`,
}

await $`mkdir -p ${outDir.pathname}`
await $`bun build --compile packages/cli/src/main.ts --outfile ${artifact.pathname}`
await Bun.write(new URL(`${artifactName}.json`, outDir), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(JSON.stringify(manifest))

function readPackageJson(value: unknown) {
  if (typeof value !== "object" || value === null || !("version" in value)) return {}
  const version = value.version
  return typeof version === "string" ? { version } : {}
}
