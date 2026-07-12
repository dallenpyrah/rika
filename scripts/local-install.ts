import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

const root = new URL("..", import.meta.url).pathname
const platform = `${process.platform}-${process.arch === "x64" ? "x64" : "arm64"}`

export const installPaths = (env: NodeJS.ProcessEnv = process.env) => {
  const installRoot = resolve(env.RIKA_INSTALL_ROOT ?? join(homedir(), ".local", "share", "rika", "current"))
  const binDir = resolve(env.RIKA_BIN_DIR ?? join(homedir(), ".local", "bin"))
  return { installRoot, command: join(binDir, "rika"), binary: join(installRoot, "bin", "rika") }
}

const exists = async (path: string) => {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

const ownsCommand = async (command: string, binary: string) => {
  const entry = await exists(command)
  if (!entry) return false
  return entry.isSymbolicLink() && resolve(dirname(command), await readlink(command)) === binary
}

const isLegacyRikaCommand = async (command: string) => {
  const entry = await exists(command)
  if (!entry?.isFile()) return false
  const contents = await readFile(command, "utf8")
  return contents.includes('SHARE_DIR="$SCRIPT_DIR/../share/rika"') && contents.includes('exec "$SCRIPT_DIR/rika-')
}

export const installLocal = async () => {
  const { installRoot, command, binary } = installPaths()
  const commandEntry = await exists(command)
  if (commandEntry && !(await ownsCommand(command, binary)) && !(await isLegacyRikaCommand(command)))
    throw new Error(`Refusing to overwrite existing command: ${command}`)
  const archive = join(root, "artifacts", `rika-${platform}.tar.gz`)
  if (!(await exists(archive))) throw new Error(`Host archive not found: ${archive}. Run bun run package:build first.`)
  await mkdir(dirname(installRoot), { recursive: true })
  const staging = await mkdtemp(join(dirname(installRoot), ".rika-install-"))
  try {
    const extracted = Bun.spawnSync(["tar", "-xzf", archive, "-C", staging])
    if (extracted.exitCode !== 0) throw new Error(extracted.stderr.toString())
    const payload = join(staging, `rika-${platform}`)
    await rm(installRoot, { recursive: true, force: true })
    await rename(payload, installRoot)
    await mkdir(dirname(command), { recursive: true })
    if (commandEntry) await rm(command)
    await symlink(binary, command)
    process.stdout.write(`Installed rika at ${binary}\nLinked ${command}\n`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export const uninstallLocal = async () => {
  const { installRoot, command, binary } = installPaths()
  if (await ownsCommand(command, binary)) await rm(command)
  await rm(installRoot, { recursive: true, force: true })
  process.stdout.write(`Uninstalled rika from ${installRoot}\n`)
}
