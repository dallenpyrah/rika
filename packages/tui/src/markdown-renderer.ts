import { StyledText, bold, fg, link, type TextChunk } from "@opentui/core"
import { colors } from "./theme"

const inline = (text: string): string =>
  text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 <$2>")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")

export const renderMarkdown = (source: string): string => {
  const output: Array<string> = []
  let fenced = false
  for (const line of source.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      output.push(line)
      continue
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
    const quote = /^\s*>\s?(.*)$/.exec(line)
    const unordered = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (heading) output.push(inline(heading[1] ?? ""))
    else if (quote) output.push(`│ ${inline(quote[1] ?? "")}`)
    else if (unordered) output.push(`${unordered[1] ?? ""}• ${inline(unordered[2] ?? "")}`)
    else if (ordered) output.push(`${ordered[1] ?? ""}${ordered[2]}. ${inline(ordered[3] ?? "")}`)
    else output.push(inline(line))
  }
  return output.join("\n")
}

const inlineChunks = (text: string): Array<TextChunk> => {
  const chunks: Array<TextChunk> = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\))/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) chunks.push(fg(colors.text)(text.slice(cursor, match.index)))
    const token = match[0]
    const linked = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
    if (linked) chunks.push(link(linked[2]!)(fg(colors.blue)(linked[1]!)))
    else if (token.startsWith("`")) chunks.push(bold(fg(colors.amber)(token.slice(1, -1))))
    else chunks.push(bold(fg(colors.text)(token.slice(2, -2))))
    cursor = match.index + token.length
  }
  if (cursor < text.length) chunks.push(fg(colors.text)(text.slice(cursor)))
  return chunks
}

export const renderMarkdownStyled = (source: string): StyledText => {
  const chunks: Array<TextChunk> = []
  let fenced = false
  source.split("\n").forEach((line, index, lines) => {
    if (/^\s*```/.test(line)) fenced = !fenced
    else {
      const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
      const quote = /^\s*>\s?(.*)$/.exec(line)
      const unordered = /^(\s*)[-*+]\s+(.*)$/.exec(line)
      if (heading) chunks.push(bold(fg(colors.blue)(heading[1] ?? "")))
      else if (fenced) chunks.push(fg(colors.teal)(line))
      else if (quote) chunks.push(fg(colors.muted)(`│ ${quote[1] ?? ""}`))
      else if (unordered) chunks.push(fg(colors.muted)(`${unordered[1] ?? ""}• `), ...inlineChunks(unordered[2] ?? ""))
      else chunks.push(...inlineChunks(line))
    }
    if (index < lines.length - 1 && !/^\s*```/.test(line)) chunks.push(fg(colors.text)("\n"))
  })
  return new StyledText(chunks)
}
