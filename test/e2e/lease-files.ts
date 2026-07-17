import { Effect, FileSystem, Path, Schema } from "effect"

export class StressResidueLeak extends Schema.TaggedErrorClass<StressResidueLeak>()("StressResidueLeak", {
  home: Schema.String,
  files: Schema.Array(Schema.String),
  missingExpectedPids: Schema.Array(Schema.Int),
}) {}

export interface StartupResidue {
  readonly kind: "startup"
  readonly path: string
}

export interface StaleOpenLog {
  readonly kind: "stale-open-log"
  readonly path: string
  readonly pid: number
  readonly role: "client" | "resident"
}

export type StressResidue = StartupResidue | StaleOpenLog

const startupFile = (name: string) => /^resident-.+\.startup(?:\..+\.tmp)?$/.test(name)

const openLog = (name: string) => {
  const matched = name.match(/^(client|resident)-.+-(\d+)\.open\.jsonl$/)
  if (matched === null) return undefined
  return { role: matched[1] as "client" | "resident", pid: Number(matched[2]) }
}

const processIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH")
  }
}

export const findResidueFiles = Effect.fn("StressResidue.find")(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (!(yield* fileSystem.exists(home))) return []
  const residue = new Array<StressResidue>()
  for (const entry of yield* fileSystem.readDirectory(home, { recursive: true })) {
    const name = path.basename(entry)
    const filename = path.join(home, entry)
    if (startupFile(name)) {
      residue.push({ kind: "startup", path: filename })
      continue
    }
    const identity = openLog(name)
    if (identity !== undefined && !processIsAlive(identity.pid)) {
      residue.push({ kind: "stale-open-log", path: filename, ...identity })
    }
  }
  return residue.toSorted((left, right) => left.path.localeCompare(right.path))
})

export const assertNoResidueFiles = Effect.fn("StressResidue.assertNone")(function* (home: string) {
  const residue = yield* findResidueFiles(home)
  if (residue.length > 0)
    return yield* StressResidueLeak.make({
      home,
      files: residue.map((entry) => entry.path),
      missingExpectedPids: [],
    })
})

export const assertAndRemoveExpectedOpenLogs = Effect.fn("StressResidue.removeExpectedOpenLogs")(function* (
  home: string,
  expectedPids: ReadonlyArray<number>,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const expected = new Set(expectedPids)
  const residue = yield* findResidueFiles(home)
  const matched = residue.filter(
    (entry): entry is StaleOpenLog => entry.kind === "stale-open-log" && expected.has(entry.pid),
  )
  const matchedPids = new Set(matched.map((entry) => entry.pid))
  const missingExpectedPids = [...expected].filter((pid) => !matchedPids.has(pid)).toSorted((a, b) => a - b)
  const unexpected = residue.filter((entry) => entry.kind === "startup" || !expected.has(entry.pid))
  if (unexpected.length > 0 || missingExpectedPids.length > 0)
    return yield* StressResidueLeak.make({
      home,
      files: unexpected.map((entry) => entry.path),
      missingExpectedPids,
    })
  yield* Effect.forEach(matched, (entry) => fileSystem.remove(entry.path), { discard: true })
  return matched
})
