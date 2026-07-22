import { ViewState } from "@rika/tui"
import { Effect, Function, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

class ExternalBoundaryError extends Schema.TaggedErrorClass<ExternalBoundaryError>()("ExternalBoundaryError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

const editorArgumentsImpl = (editor: string, path: string, line?: number, column?: number): Array<string> => {
  const location = line === undefined ? path : `${path}:${line}${column === undefined ? "" : `:${column}`}`
  return editor === "code" || editor.endsWith("/code")
    ? [editor, "--goto", location]
    : editor === "vim" || editor === "nvim" || editor.endsWith("/vim") || editor.endsWith("/nvim")
      ? [editor, ...(line === undefined ? [] : [`+call cursor(${line},${column ?? 1})`]), path]
      : [editor, path]
}

export const editorArguments: {
  (path: string, line?: number, column?: number): (editor: string) => Array<string>
  (editor: string, path: string, line?: number, column?: number): Array<string>
} = Function.dual((args) => args.length >= 2, editorArgumentsImpl)

const defaultOpenArgumentsImpl = (path: string, platform: NodeJS.Platform = process.platform): Array<string> =>
  platform === "darwin"
    ? ["open", path]
    : platform === "win32"
      ? [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Start-Process -LiteralPath $args[0]",
          "--",
          path,
        ]
      : ["xdg-open", path]

export const defaultOpenArguments: {
  (platform?: NodeJS.Platform): (path: string) => Array<string>
  (path: string, platform?: NodeJS.Platform): Array<string>
} = Function.dual((args) => args.length >= 1, defaultOpenArgumentsImpl)

const parseChangedFilesImpl = (statusText: string, numstatText: string): ReadonlyArray<ViewState.ChangedFile> => {
  const counts = new Map<string, { added: number; removed: number }>()
  const numstatRecords = numstatText.split("\0")
  for (let index = 0; index < numstatRecords.length - 1; index += 1) {
    const record = numstatRecords[index]!
    const firstTab = record.indexOf("\t")
    const secondTab = record.indexOf("\t", firstTab + 1)
    const added = record.slice(0, firstTab)
    const removed = record.slice(firstTab + 1, secondTab)
    const inlinePath = record.slice(secondTab + 1)
    const path = inlinePath.length > 0 ? inlinePath : numstatRecords[(index += 2)]!
    counts.set(path, { added: added === "-" ? 0 : Number(added), removed: removed === "-" ? 0 : Number(removed) })
  }
  const files: Array<ViewState.ChangedFile> = []
  const statusRecords = statusText.split("\0")
  for (let index = 0; index < statusRecords.length - 1; index += 1) {
    const record = statusRecords[index]!
    const status = record.slice(0, 2).trim()
    const path = record.slice(3)
    if (status.includes("R") || status.includes("C")) index += 1
    const count = counts.get(path)
    files.push(count === undefined ? { path, status } : { path, status, added: count.added, removed: count.removed })
  }
  return files
}

export const parseChangedFiles: {
  (numstatText: string): (statusText: string) => ReadonlyArray<ViewState.ChangedFile>
  (statusText: string, numstatText: string): ReadonlyArray<ViewState.ChangedFile>
} = Function.dual(2, parseChangedFilesImpl)

export const gitOutput = (arguments_: ReadonlyArray<string>) => {
  const [executable, ...args] = arguments_
  if (executable === undefined)
    return Effect.fail(ExternalBoundaryError.make({ operation: "run command", message: "Missing command" }))
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const child = yield* spawner.spawn(ChildProcess.make(executable, args, { stdout: "pipe", stderr: "ignore" }))
      return yield* Effect.all([Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode], { concurrency: 2 })
    }).pipe(
      Effect.mapError((cause) =>
        ExternalBoundaryError.make({ operation: arguments_.join(" "), message: String(cause) }),
      ),
    ),
  )
}

const childExit = (operation: string, arguments_: ReadonlyArray<string>, options: ChildProcess.CommandOptions) => {
  const [executable, ...args] = arguments_
  if (executable === undefined)
    return Effect.fail(ExternalBoundaryError.make({ operation, message: "Missing command" }))
  return Effect.scoped(
    ChildProcessSpawner.ChildProcessSpawner.pipe(
      Effect.flatMap((spawner) => spawner.spawn(ChildProcess.make(executable, args, options))),
      Effect.flatMap((child) => child.exitCode),
      Effect.mapError((cause) => ExternalBoundaryError.make({ operation, message: String(cause) })),
    ),
  )
}

export const internal = { childExit }

export const readChangedFiles = Effect.fn("WorkspaceActions.readChangedFiles")(function* (workspace: string) {
  const [statusText, statusExit] = yield* gitOutput([
    "git",
    "-C",
    workspace,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ])
  if (statusExit !== 0) return []
  const [headText, headExit] = yield* gitOutput(["git", "-C", workspace, "rev-parse", "--verify", "HEAD"])
  let base = headExit === 0 ? headText.trim() : undefined
  if (base === undefined) {
    const [emptyTree, emptyTreeExit] = yield* gitOutput([
      "git",
      "-C",
      workspace,
      "hash-object",
      "-t",
      "tree",
      "/dev/null",
    ])
    base = emptyTreeExit === 0 ? emptyTree.trim() : undefined
  }
  if (base === undefined) return []
  const [numstatText, numstatExit] = yield* gitOutput(["git", "-C", workspace, "diff", "--numstat", "-z", "-M", base])
  return numstatExit === 0 ? parseChangedFiles(statusText, numstatText) : []
})

const refreshChangedFilesOnImpl = <A, E, R, E2, R2>(
  changes: Stream.Stream<A, E, R>,
  isOpen: () => boolean,
  refresh: Effect.Effect<void, E2, R2>,
) =>
  changes.pipe(
    Stream.debounce("150 millis"),
    Stream.runForEach(() => (isOpen() ? refresh : Effect.void)),
  )

export const refreshChangedFilesOn: {
  <E2, R2>(
    isOpen: () => boolean,
    refresh: Effect.Effect<void, E2, R2>,
  ): <A, E, R>(changes: Stream.Stream<A, E, R>) => Effect.Effect<void, E | E2, R | R2>
  <A, E, R, E2, R2>(
    changes: Stream.Stream<A, E, R>,
    isOpen: () => boolean,
    refresh: Effect.Effect<void, E2, R2>,
  ): Effect.Effect<void, E | E2, R | R2>
} = Function.dual(3, refreshChangedFilesOnImpl)
