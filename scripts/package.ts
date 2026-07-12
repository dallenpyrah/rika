import { createHash } from "node:crypto"
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

export const targets = {
  "darwin-arm64": {
    bun: "bun-darwin-arm64",
    opentui: "@opentui/core-darwin-arm64",
    fff: "@ff-labs/fff-bin-darwin-arm64",
  },
  "darwin-x64": { bun: "bun-darwin-x64", opentui: "@opentui/core-darwin-x64", fff: "@ff-labs/fff-bin-darwin-x64" },
  "linux-arm64": {
    bun: "bun-linux-arm64",
    opentui: "@opentui/core-linux-arm64",
    fff: "@ff-labs/fff-bin-linux-arm64-gnu",
  },
  "linux-x64": {
    bun: "bun-linux-x64",
    opentui: "@opentui/core-linux-x64",
    fff: "@ff-labs/fff-bin-linux-x64-gnu",
  },
} as const

const root = new URL("..", import.meta.url).pathname
const output = join(root, "artifacts")
const platformPackageVersion = "0.4.2"
const platformPackages = [
  "@opentui/core-darwin-arm64",
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-win32-arm64",
  "@opentui/core-win32-x64",
]
const sha256 = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex")
const locatePackage = async (name: string, version: string, cache: string) => {
  const exact = join(root, "node_modules", name)
  try {
    await stat(exact)
    return exact
  } catch {}
  const prefix = name.replace("/", "+") + "@"
  const entries = await readdir(join(root, "node_modules", ".bun"))
  const found = entries.toSorted().find((entry) => entry.startsWith(prefix))
  if (found) return join(root, "node_modules", ".bun", found, "node_modules", name)
  const destination = join(cache, name.replace("/", "+"))
  await mkdir(destination, { recursive: true })
  const packed = Bun.spawnSync([
    "npm",
    "pack",
    `${name}@${version}`,
    "--ignore-scripts",
    "--pack-destination",
    destination,
  ])
  if (packed.exitCode !== 0)
    throw new Error(`Could not fetch pinned optional package ${name}@${platformPackageVersion}: ${packed.stderr}`)
  const archive = (await readdir(destination)).find((entry) => entry.endsWith(".tgz"))
  if (!archive) throw new Error(`npm did not produce an archive for ${name}@${platformPackageVersion}`)
  const extracted = Bun.spawnSync(["tar", "-xzf", join(destination, archive), "-C", destination])
  if (extracted.exitCode !== 0) throw new Error(extracted.stderr.toString())
  const manifest = JSON.parse(await readFile(join(destination, "package", "package.json"), "utf8")) as {
    name?: string
    version?: string
  }
  if (manifest.name !== name || manifest.version !== version)
    throw new Error(`Fetched optional package did not match ${name}@${version}`)
  return join(destination, "package")
}

const main = async () => {
  const selected = process.argv.includes("--target")
    ? [process.argv[process.argv.indexOf("--target") + 1]!]
    : Object.keys(targets)
  for (const name of selected)
    if (name.startsWith("win32-")) throw new Error(`Unsupported target: ${name}. Windows archives are not supported.`)
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  const packageCache = join(output, ".platform-packages")
  const buildTarget = async (name: string): Promise<Record<string, unknown>> => {
    if (!(name in targets)) throw new Error(`Unsupported target: ${name}`)
    const target = targets[name as keyof typeof targets]
    const stageName = `rika-${name}`
    const stage = join(output, stageName)
    await mkdir(join(stage, "bin"), { recursive: true })
    const packageSource = await locatePackage(target.opentui, platformPackageVersion, packageCache)
    const fffSource = await locatePackage(target.fff, "0.9.6", packageCache)
    const fffNodeSource = await locatePackage("@ff-labs/fff-node", "0.9.6", packageCache)
    const ffiSource = await locatePackage("ffi-rs", "1.3.2", packageCache)
    const resolutionPackage = join(root, "node_modules", ...target.opentui.split("/"))
    let removeResolutionPackage = false
    try {
      await stat(resolutionPackage)
    } catch {
      await mkdir(resolutionPackage, { recursive: true })
      await cp(packageSource, resolutionPackage, { recursive: true, dereference: true })
      removeResolutionPackage = true
    }
    const result = Bun.spawnSync([
      "bun",
      "build",
      "--compile",
      `--target=${target.bun}`,
      ...platformPackages
        .filter((packageName) => packageName !== target.opentui)
        .flatMap((packageName) => ["--external", packageName]),
      "--outfile",
      join(stage, "bin", "rika"),
      join(root, "apps/rika/src/main.ts"),
    ])
    if (removeResolutionPackage) await rm(resolutionPackage, { recursive: true, force: true })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    await chmod(join(stage, "bin", "rika"), 0o755)
    const packageDestination = join(stage, "bin", "node_modules", ...target.opentui.split("/"))
    await mkdir(packageDestination, { recursive: true })
    await cp(packageSource, packageDestination, {
      recursive: true,
      dereference: true,
    })
    for (const [packageName, source] of [
      [target.fff, fffSource],
      ["@ff-labs/fff-node", fffNodeSource],
      ["ffi-rs", ffiSource],
    ] as const) {
      const destination = join(stage, "bin", "node_modules", ...packageName.split("/"))
      await mkdir(destination, { recursive: true })
      await cp(source, destination, { recursive: true, dereference: true })
    }
    await writeFile(join(stage, "INSTALL"), "Install bin/rika on PATH. Keep node_modules adjacent to bin.\n")
    const archive = join(output, `${stageName}.tar.gz`)
    const tar = Bun.spawnSync([
      "python3",
      "-c",
      `
import gzip, os, tarfile, sys
root, name, output = sys.argv[1:]
with open(output, "wb") as raw:
  with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as zipped:
    with tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as archive:
      for base, dirs, files in os.walk(os.path.join(root, name)):
        dirs.sort(); files.sort()
        for entry in dirs + files:
          path = os.path.join(base, entry); info = archive.gettarinfo(path, os.path.relpath(path, root))
          info.uid = info.gid = 0; info.uname = info.gname = ""; info.mtime = 0
          if info.isfile():
            with open(path, "rb") as source: archive.addfile(info, source)
          else: archive.addfile(info)
`,
      output,
      stageName,
      archive,
    ])
    if (tar.exitCode !== 0) throw new Error(tar.stderr.toString())
    const evidence = {
      target: name,
      archive: basename(archive),
      sha256: await sha256(archive),
      opentui: target.opentui,
    }
    await rm(stage, { recursive: true, force: true })
    return evidence
  }
  const buildSelected = async (names: ReadonlyArray<string>): Promise<ReadonlyArray<Record<string, unknown>>> =>
    names.length === 0 ? [] : [await buildTarget(names[0]!), ...(await buildSelected(names.slice(1)))]
  const evidence = await buildSelected(selected)
  await rm(packageCache, { recursive: true, force: true })
  await writeFile(
    join(output, "release-evidence.json"),
    `${JSON.stringify({ schemaVersion: 1, bun: Bun.version, artifacts: evidence }, null, 2)}\n`,
  )
  await writeFile(
    join(output, "SHA256SUMS"),
    evidence.map((item) => `${item.sha256}  ${item.archive}`).join("\n") + "\n",
  )
}

if (import.meta.main) await main()
