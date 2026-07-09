#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"

const dataDir = process.env.RIKA_DATA_DIR ?? join(process.env.HOME ?? homedir(), ".rika")
if (process.env.RIVET_LOG_LEVEL === undefined || process.env.RIVET_LOG_LEVEL.length === 0) {
  process.env.RIVET_LOG_LEVEL = "silent"
}

if (process.env.RIVETKIT_STORAGE_PATH === undefined || process.env.RIVETKIT_STORAGE_PATH.length === 0) {
  process.env.RIVETKIT_STORAGE_PATH = join(dataDir, "rivetkit")
}

const executableCandidates = [process.execPath, process.argv[0], Bun.argv[0]].filter(
  (path): path is string => path !== undefined && path.length > 0,
)
const shareRoot = executableCandidates
  .map((path) => join(dirname(path), "..", "share", "rika"))
  .find((path) => existsSync(path))

if (shareRoot !== undefined) {
  const enginePath = join(shareRoot, "bin", process.platform === "win32" ? "rivet-engine.exe" : "rivet-engine")
  if (
    existsSync(enginePath) &&
    (process.env.RIVET_ENGINE_BINARY === undefined || process.env.RIVET_ENGINE_BINARY.length === 0)
  ) {
    process.env.RIVET_ENGINE_BINARY = enginePath
  }
}

const sidecarNodeModulesPath = shareRoot === undefined ? undefined : join(shareRoot, "rivet-host", "node_modules")
if (sidecarNodeModulesPath !== undefined && existsSync(sidecarNodeModulesPath)) {
  process.env.NODE_PATH =
    process.env.NODE_PATH === undefined || process.env.NODE_PATH.length === 0
      ? sidecarNodeModulesPath
      : `${sidecarNodeModulesPath}${delimiter}${process.env.NODE_PATH}`
}

const { Effect } = await import("effect")
const { Output, Runtime } = await import("./index")

const exitCode = await Effect.runPromise(
  Runtime.runProcess({ argv: Bun.argv.slice(2), env: process.env, cwd: process.cwd() }).pipe(
    Effect.provide(Output.layer),
  ),
)

process.exit(exitCode)
