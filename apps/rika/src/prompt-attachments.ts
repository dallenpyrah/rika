import * as Turn from "@rika/persistence/turn"
import { Session, ViewState } from "@rika/tui"
import { Effect, FileSystem, Function, Option, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { maxClientMessageBytes } from "./resident-wire"

export class PromptAttachmentError extends Schema.TaggedErrorClass<PromptAttachmentError>()("PromptAttachmentError", {
  index: Schema.Int,
  path: Schema.String,
  message: Schema.String,
}) {}

export const imagePasteBlockedNotice = (model: Pick<ViewState.Model, "editingTurnId">): string | undefined =>
  model.editingTurnId === undefined ? undefined : "Images cannot be pasted while editing a queued prompt"

const imageMediaType = (path: string) => {
  const lower = path.toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".webp")) return "image/webp"
  return "application/octet-stream"
}

const pastedImageFormat = (bytes: Uint8Array, declaredMediaType?: string) => {
  const prefix = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end))
  const signature =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
      ? { mediaType: "image/png", extension: "png" }
      : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        ? { mediaType: "image/jpeg", extension: "jpg" }
        : bytes.length >= 6 && /^GIF8[79]a$/.test(prefix(0, 6))
          ? { mediaType: "image/gif", extension: "gif" }
          : bytes.length >= 12 && prefix(0, 4) === "RIFF" && prefix(8, 12) === "WEBP"
            ? { mediaType: "image/webp", extension: "webp" }
            : undefined
  if (signature === undefined) return undefined
  const mediaType = declaredMediaType?.split(";", 1)[0]?.trim().toLowerCase()
  return mediaType === undefined || mediaType === signature.mediaType ? signature : undefined
}

export const maxAttachmentBytes = 5_000_000
const maxPromptPartsBytes = maxClientMessageBytes - 65_536
const attachmentMegabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`

const materializePromptPartsImpl = (parts: ReadonlyArray<ViewState.PromptPart>, workspace: string) =>
  Effect.forEach(
    parts,
    (part, index): Effect.Effect<Turn.PromptPart, PromptAttachmentError, FileSystem.FileSystem> => {
      if (part.type === "text") return Effect.succeed(part)
      const path = part.path.startsWith("/") ? part.path : `${workspace}/${part.path}`
      const failure = (cause: unknown) =>
        PromptAttachmentError.make({
          index,
          path: part.path,
          message: `Image attachment could not be read: ${String(cause)}`,
        })
      return FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          Effect.all([fileSystem.stat(path), fileSystem.readFile(path)]).pipe(Effect.mapError(failure)),
        ),
        Effect.flatMap(([info, bytes]) =>
          info.type !== "File" || bytes.byteLength === 0
            ? Effect.fail(
                PromptAttachmentError.make({
                  index,
                  path: part.path,
                  message: `Image attachment is missing or empty: ${part.path}`,
                }),
              )
            : bytes.byteLength > maxAttachmentBytes
              ? Effect.fail(
                  PromptAttachmentError.make({
                    index,
                    path: part.path,
                    message: `Image attachment is too large (${attachmentMegabytes(bytes.byteLength)}; the limit is ${attachmentMegabytes(maxAttachmentBytes)}): ${part.path}`,
                  }),
                )
              : Effect.succeed({ mediaType: imageMediaType(path), bytes }),
        ),
        Effect.flatMap(({ mediaType, bytes }) =>
          !mediaType.startsWith("image/")
            ? Effect.fail(
                PromptAttachmentError.make({
                  index,
                  path: part.path,
                  message: `Unsupported image attachment: ${part.path}`,
                }),
              )
            : Effect.succeed({
                type: "image" as const,
                mediaType,
                data: Buffer.from(bytes).toString("base64"),
                filename: part.path,
              }),
        ),
      )
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.flatMap((materialized) => {
      const images = materialized.flatMap((part, index) =>
        part.type === "image" ? [{ index, bytes: part.data.length }] : [],
      )
      if (images.reduce((sum, image) => sum + image.bytes, 0) <= maxPromptPartsBytes)
        return Effect.succeed(materialized)
      const largest = images.reduce((left, right) => (right.bytes > left.bytes ? right : left))
      const part = parts[largest.index]
      return Effect.fail(
        PromptAttachmentError.make({
          index: largest.index,
          path: part?.type === "image" ? part.path : "",
          message: "Image attachments exceed the 16 MiB prompt limit; remove an image and try again",
        }),
      )
    }),
  )

export const materializePromptParts: {
  (workspace: string): (parts: ReadonlyArray<ViewState.PromptPart>) => ReturnType<typeof materializePromptPartsImpl>
  (parts: ReadonlyArray<ViewState.PromptPart>, workspace: string): ReturnType<typeof materializePromptPartsImpl>
} = Function.dual(2, materializePromptPartsImpl)

const initialSubmitActionImpl = (
  prompt: ReadonlyArray<string>,
  mode: ViewState.Mode,
): Extract<Session.Action, { readonly _tag: "Submit" }> | undefined => {
  if (prompt.length === 0) return undefined
  const value = prompt.join(" ")
  return { _tag: "Submit", prompt: value, parts: ViewState.promptParts(value), mode }
}
export const initialSubmitAction: {
  (mode: ViewState.Mode): (prompt: ReadonlyArray<string>) => ReturnType<typeof initialSubmitActionImpl>
  (prompt: ReadonlyArray<string>, mode: ViewState.Mode): ReturnType<typeof initialSubmitActionImpl>
} = Function.dual(2, initialSubmitActionImpl)

export class ClipboardExtractionError extends Schema.TaggedErrorClass<ClipboardExtractionError>()(
  "ClipboardExtractionError",
  { message: Schema.String },
) {}
type ClipboardPngExtractor = (
  script: string,
  path: string,
) => Effect.Effect<number, ClipboardExtractionError, ChildProcessSpawner.ChildProcessSpawner>
const runClipboardPngExtractor: ClipboardPngExtractor = (script, path) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const child = yield* spawner.spawn(
        ChildProcess.make("osascript", ["-e", script, "--", path], { stdout: "ignore", stderr: "ignore" }),
      )
      return yield* child.exitCode
    }).pipe(Effect.mapError((cause) => ClipboardExtractionError.make({ message: String(cause) }))),
  )

const pasteClipboardPngImpl = (
  workspace: string,
  now = Date.now,
  extract: ClipboardPngExtractor = runClipboardPngExtractor,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const relative = `.rika/pasted/paste-${now()}.png`
    const absolute = `${workspace}/${relative}`
    yield* fileSystem.makeDirectory(`${workspace}/.rika/pasted`, { recursive: true })
    yield* fileSystem.writeFile(absolute, new Uint8Array())
    const script = `on run argv\nset pngData to (the clipboard as «class PNGf»)\nset theFile to (POSIX file (item 1 of argv))\nset fh to open for access theFile with write permission\nset eof fh to 0\nwrite pngData to fh\nclose access fh\nend run`
    const exit = yield* extract(script, absolute).pipe(Effect.orElseSucceed(() => -1))
    const info = yield* fileSystem.stat(absolute).pipe(Effect.option)
    const extracted = exit === 0 && Option.isSome(info) && info.value.type === "File" && info.value.size > 0
    if (!extracted) yield* fileSystem.remove(absolute).pipe(Effect.ignore)
    return extracted ? relative : undefined
  }).pipe(Effect.orElseSucceed(() => undefined))
export const pasteClipboardPng: {
  (now?: () => number, extract?: ClipboardPngExtractor): (workspace: string) => ReturnType<typeof pasteClipboardPngImpl>
  (workspace: string, now?: () => number, extract?: ClipboardPngExtractor): ReturnType<typeof pasteClipboardPngImpl>
} = Function.dual((args) => typeof args[0] === "string", pasteClipboardPngImpl)

const pastedImagePathImpl = (
  bytes: Uint8Array,
  mediaType?: string,
  now = Date.now,
  id = crypto.randomUUID,
): string | undefined => {
  const format = pastedImageFormat(bytes, mediaType)
  return format === undefined ? undefined : `.rika/pasted/paste-${now()}-${id()}.${format.extension}`
}
export const pastedImagePath: {
  (
    mediaType?: string,
    now?: () => number,
    id?: () => `${string}-${string}-${string}-${string}-${string}`,
  ): (bytes: Uint8Array) => string | undefined
  (
    bytes: Uint8Array,
    mediaType?: string,
    now?: () => number,
    id?: () => `${string}-${string}-${string}-${string}-${string}`,
  ): string | undefined
} = Function.dual((args) => args[0] instanceof Uint8Array, pastedImagePathImpl)

const persistPastedImageImpl = (workspace: string, relative: string, bytes: Uint8Array) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem
        .makeDirectory(`${workspace}/.rika/pasted`, { recursive: true })
        .pipe(Effect.andThen(fileSystem.writeFile(`${workspace}/${relative}`, bytes))),
    ),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )
export const persistPastedImage: {
  (relative: string, bytes: Uint8Array): (workspace: string) => ReturnType<typeof persistPastedImageImpl>
  (workspace: string, relative: string, bytes: Uint8Array): ReturnType<typeof persistPastedImageImpl>
} = Function.dual(3, persistPastedImageImpl)
