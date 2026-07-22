import { Function } from "effect"
import type { Key } from "../keys"
import type { ComposerAttachment, Model, PromptPart } from "./model"

export type PromptSubmission =
  | { readonly _tag: "Prompt"; readonly prompt: string }
  | { readonly _tag: "Shell"; readonly command: string; readonly incognito: boolean }

export const classifyPrompt = (input: string): PromptSubmission => {
  if (input.startsWith("$$")) return { _tag: "Shell", command: input.slice(2).trimStart(), incognito: true }
  if (input.startsWith("$")) return { _tag: "Shell", command: input.slice(1).trimStart(), incognito: false }
  return { _tag: "Prompt", prompt: input }
}

const imagePathPattern =
  /@image:(?:"([^"]+\.(?:png|jpe?g|gif|webp))"|'([^']+\.(?:png|jpe?g|gif|webp))'|([^\s,;]+\.(?:png|jpe?g|gif|webp)))|\[([^\]\n]+\.(?:png|jpe?g|gif|webp))\]|(?:file:\/\/[^\s]+\.(?:png|jpe?g|gif|webp))|(?:(?:\\ |[^\s[\]])+\.(?:png|jpe?g|gif|webp))/gi

const appendPromptPart = (parts: Array<PromptPart>, part: PromptPart): void => {
  const previous = parts.at(-1)
  if (part.type === "text" && previous?.type === "text") {
    parts[parts.length - 1] = { type: "text", text: previous.text + part.text }
    return
  }
  parts.push(part)
}

const appendParsedText = (parts: Array<PromptPart>, text: string): void => {
  let offset = 0
  for (const match of text.matchAll(imagePathPattern)) {
    const index = match.index
    if (index > offset) appendPromptPart(parts, { type: "text", text: text.slice(offset, index) })
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[0]
    let path = value
    if (path.startsWith("file://")) {
      try {
        path = decodeURIComponent(new URL(path).pathname)
      } catch {}
    }
    appendPromptPart(parts, { type: "image", path: path.replace(/\\ /g, " ") })
    offset = index + match[0].length
  }
  if (offset < text.length) appendPromptPart(parts, { type: "text", text: text.slice(offset) })
}

export const promptParts: {
  (input: string, pastedText?: ReadonlyArray<ComposerAttachment>): ReadonlyArray<PromptPart>
  (pastedText?: ReadonlyArray<ComposerAttachment>): (input: string) => ReadonlyArray<PromptPart>
} = Function.dual(
  (args) => args.length > 1 || typeof args[0] === "string",
  (input: string, pastedText: ReadonlyArray<ComposerAttachment> = []): ReadonlyArray<PromptPart> => {
    const parts: Array<PromptPart> = []
    for (const value of input.split(/([\uE000-\uF8FF])/u)) {
      const attachment = pastedText.find((candidate) => candidate.token === value)
      if (attachment?.type === "image") appendPromptPart(parts, { type: "image", path: attachment.path })
      else appendParsedText(parts, attachment?.type === "text" ? attachment.value : value)
    }
    return parts.length === 0 ? [{ type: "text", text: "" }] : parts
  },
)

const insert = (model: Model, value: string): Model => ({
  ...model,
  input: model.input.slice(0, model.cursor) + value + model.input.slice(model.cursor),
  cursor: model.cursor + value.length,
  historyIndex: undefined,
  historyDraft: undefined,
})

const erase = (value: Model, length: number): Model => ({
  ...value,
  input: value.input.slice(0, Math.max(0, value.cursor - length)) + value.input.slice(value.cursor),
  cursor: Math.max(0, value.cursor - length),
})

export const lastCharacterLength = (value: string): number => Array.from(value).at(-1)?.length ?? 0

export const fileMention = (path: string): string => `@${/\s/u.test(path) ? `"${path}"` : path} `

export const questionKey = (key: Key): boolean => !key.ctrl && !key.alt && !key.meta && key.sequence === "?"

const composerContext = (model: Model): boolean =>
  !model.threadSwitcher.open &&
  !model.threadSidebar.focused &&
  !model.paletteOpen &&
  !model.palette.open &&
  !model.modePicker.open &&
  !model.filePicker.open

const continueShortcutsAfterEdit = (before: Model, after: Model): Model => {
  const trigger = before.shortcutsTrigger
  if (trigger === undefined || before.input[trigger] !== "?" || !composerContext(after))
    return { ...after, shortcutsOpen: false, shortcutsTrigger: undefined }
  if (before.input === after.input) return { ...after, shortcutsOpen: true, shortcutsTrigger: trigger }
  let prefix = 0
  while (prefix < before.input.length && prefix < after.input.length && before.input[prefix] === after.input[prefix])
    prefix += 1
  let suffix = 0
  while (
    suffix < before.input.length - prefix &&
    suffix < after.input.length - prefix &&
    before.input[before.input.length - 1 - suffix] === after.input[after.input.length - 1 - suffix]
  )
    suffix += 1
  const oldEnd = before.input.length - suffix
  const nextTrigger =
    trigger < prefix ? trigger : trigger >= oldEnd ? trigger + after.input.length - before.input.length : -1
  return nextTrigger >= 0 && after.input[nextTrigger] === "?"
    ? { ...after, shortcutsOpen: true, shortcutsTrigger: nextTrigger }
    : { ...after, shortcutsOpen: false, shortcutsTrigger: undefined }
}

const insertWhileShortcutsOpen = (model: Model, value: string): Model => {
  const trigger = model.shortcutsTrigger
  const next = insert(model, value)
  return trigger === undefined
    ? next
    : { ...next, shortcutsTrigger: model.cursor <= trigger ? trigger + value.length : trigger }
}

const pastedImagePath = (value: string): string | undefined => {
  const trimmed = value.trim()
  const quoted = (/^'.*'$/s.test(trimmed) || /^".*"$/s.test(trimmed)) && trimmed.length >= 2
  const unquoted = quoted ? trimmed.slice(1, -1) : trimmed
  const pathLike =
    quoted || /^(?:file:\/\/|~\/|\.{0,2}\/|\/)/i.test(unquoted) || unquoted.includes("\\ ") || !/\s/.test(unquoted)
  if (!pathLike || !/\.(?:png|jpe?g|gif|webp)$/i.test(unquoted)) return undefined
  if (unquoted.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(unquoted).pathname)
    } catch {}
  }
  return unquoted.replace(/\\ /g, " ")
}

const insertPaste = (model: Model, value: string): Model => {
  const imagePath = pastedImagePath(value)
  if (imagePath !== undefined) return insertImage(model, imagePath)
  if (!value.includes("\n") && !value.includes("\r") && [...value].length <= 120) return insert(model, value)
  const token = String.fromCharCode(0xe000 + model.pastedText.length)
  const lines = value.split(/\r\n|\r|\n/).length
  const label =
    lines > 1
      ? `[Pasted text #${model.pastedText.length + 1} +${lines} lines]`
      : `[Pasted text #${model.pastedText.length + 1}]`
  const next = insert(model, token)
  return { ...next, pastedText: [...model.pastedText, { type: "text", token, value, label }] }
}

const insertImage = (model: Model, path: string): Model => {
  if (model.editingTurnId !== undefined) return model
  const token = String.fromCharCode(0xe000 + model.pastedText.length)
  const imageCount = model.pastedText.filter((attachment) => attachment.type === "image").length
  const next = insert(model, token)
  return {
    ...next,
    pastedText: [...model.pastedText, { type: "image", token, path, label: `[Image #${imageCount + 1}]` }],
  }
}

const removeImage = (model: Model, path: string): Model => {
  const attachment = model.pastedText.find(
    (candidate): candidate is Extract<ComposerAttachment, { readonly type: "image" }> =>
      candidate.type === "image" && candidate.path === path,
  )
  if (attachment === undefined) return model
  const offset = model.input.indexOf(attachment.token)
  return {
    ...model,
    input: model.input.replace(attachment.token, ""),
    cursor: offset >= 0 && model.cursor > offset ? model.cursor - attachment.token.length : model.cursor,
    pastedText: model.pastedText.filter((candidate) => candidate !== attachment),
  }
}

export const displayInput = (model: Model): string =>
  model.pastedText.reduce((text, attachment) => text.replaceAll(attachment.token, attachment.label), model.input)

export const expandPastedText: {
  (input: string, pastedText: ReadonlyArray<ComposerAttachment>): string
  (pastedText: ReadonlyArray<ComposerAttachment>): (input: string) => string
} = Function.dual(2, (input: string, pastedText: ReadonlyArray<ComposerAttachment>): string =>
  pastedText.reduce(
    (text, attachment) =>
      text.replaceAll(attachment.token, attachment.type === "image" ? attachment.label : attachment.value),
    input,
  ),
)

export const pastedTextTokenAt: {
  (model: Model, displayOffset: number): string | undefined
  (displayOffset: number): (model: Model) => string | undefined
} = Function.dual(2, (model: Model, displayOffset: number): string | undefined => {
  let offset = 0
  for (const part of model.input.split(/([\uE000-\uF8FF])/u)) {
    const attachment = model.pastedText.find((candidate) => candidate.token === part)
    const width = attachment?.label.length ?? part.length
    if (attachment !== undefined && displayOffset >= offset && displayOffset < offset + width) return attachment.token
    offset += width
  }
  return undefined
})

const expandPastedTextAttachment = (model: Model, token: string): Model => {
  const attachment = model.pastedText.find((candidate) => candidate.token === token)
  const tokenOffset = model.input.indexOf(token)
  if (attachment === undefined || attachment.type === "image" || tokenOffset < 0) return model
  return {
    ...model,
    input: model.input.replace(token, attachment.value),
    cursor: model.cursor > tokenOffset ? model.cursor + attachment.value.length - token.length : model.cursor,
    pastedText: model.pastedText.filter((candidate) => candidate.token !== token),
  }
}

export const internal = {
  insert,
  erase,
  continueShortcutsAfterEdit,
  insertWhileShortcutsOpen,
  insertPaste,
  insertImage,
  removeImage,
  expandPastedTextAttachment,
}
