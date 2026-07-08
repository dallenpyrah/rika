import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

export const installedRivetHostEntryPath = (executablePath = process.execPath) =>
  join(dirname(executablePath), "..", "share", "rika", "rivet-host", "index.js")

export const isCompiledBinary = () => import.meta.url.includes("/$bunfs/")

export const loadRivetHostModule = () =>
  isCompiledBinary()
    ? import(pathToFileURL(installedRivetHostEntryPath()).href)
    : import(["@rika", "rivet-host"].join("/"))
