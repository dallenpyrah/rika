import { StyledText, bold, dim, fg, italic, link, strikethrough, underline, type TextChunk } from "@opentui/core"
import { Lexer, type Token, type Tokens } from "marked"
import { highlightLines } from "./syntax-highlight"
import { colors } from "./theme"

type Lines = Array<Array<TextChunk>>

const splitChunks = (chunks: ReadonlyArray<TextChunk>): Lines => {
  const lines: Lines = [[]]
  for (const chunk of chunks) {
    chunk.text.split("\n").forEach((piece, index) => {
      if (index > 0) lines.push([])
      if (piece.length > 0) lines[lines.length - 1]!.push({ ...chunk, text: piece })
    })
  }
  return lines
}

const trailingBlankLines = (raw: string): number => {
  const match = /\n+$/.exec(raw)
  return match === null ? 0 : Math.max(0, match[0].length - 1)
}

const inlineChunks = (tokens: ReadonlyArray<Token>, plain: boolean): Array<TextChunk> => {
  const chunks: Array<TextChunk> = []
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text
        if (text.tokens !== undefined && text.tokens.length > 0) chunks.push(...inlineChunks(text.tokens, plain))
        else chunks.push(fg(colors.text)(text.text))
        break
      }
      case "escape":
        chunks.push(fg(colors.text)((token as Tokens.Escape).text))
        break
      case "strong":
        chunks.push(...inlineChunks((token as Tokens.Strong).tokens, plain).map((chunk) => bold(chunk)))
        break
      case "em":
        chunks.push(...inlineChunks((token as Tokens.Em).tokens, plain).map((chunk) => italic(chunk)))
        break
      case "del":
        chunks.push(...inlineChunks((token as Tokens.Del).tokens, plain).map((chunk) => strikethrough(chunk)))
        break
      case "codespan":
        chunks.push(bold(fg(colors.amber)((token as Tokens.Codespan).text)))
        break
      case "link": {
        const linked = token as Tokens.Link
        if (plain) chunks.push(fg(colors.text)(`${linked.text} <${linked.href}>`))
        else chunks.push(link(linked.href)(underline(fg(colors.blue)(linked.text))))
        break
      }
      case "image":
        chunks.push(italic(fg(colors.blue)(`[Image: ${(token as Tokens.Image).text}]`)))
        break
      case "br":
        chunks.push(fg(colors.text)("\n"))
        break
      default:
        chunks.push(fg(colors.text)(token.raw))
    }
  }
  return chunks
}

const listLines = (list: Tokens.List, depth: number, plain: boolean): Lines => {
  const lines: Lines = []
  const indent = "  ".repeat(depth)
  list.items.forEach((item, index) => {
    const markerMatch = /^[ \t]*((?:[-*+])|(?:\d{1,9}[.)]))[ \t]+/.exec(item.raw)
    const checkbox = item.task === true ? (item.checked === true ? "[x] " : "[ ] ") : ""
    const marker = `${indent}${markerMatch?.[1] ?? "-"} ${checkbox}`
    const continuation = " ".repeat(marker.length)
    const itemLines: Lines = []
    const passthrough: Array<boolean> = []
    for (const token of item.tokens) {
      const isList = token.type === "list"
      for (const line of blockLines([token], depth + 1, plain)) {
        itemLines.push(line)
        passthrough.push(isList)
      }
    }
    while (itemLines.length > 0 && itemLines[itemLines.length - 1]!.length === 0) {
      itemLines.pop()
      passthrough.pop()
    }
    if (itemLines.length === 0) itemLines.push([])
    let firstContent = true
    itemLines.forEach((line, lineIndex) => {
      if (passthrough[lineIndex] === true) lines.push(line)
      else if (firstContent) {
        lines.push([fg(colors.text)(marker), ...line])
        firstContent = false
      } else if (line.length === 0) lines.push([])
      else lines.push([fg(colors.text)(continuation), ...line])
    })
    if (list.loose && index < list.items.length - 1) lines.push([])
  })
  return lines
}

const blockLines = (tokens: ReadonlyArray<Token>, depth: number, plain: boolean): Lines => {
  const lines: Lines = []
  tokens.forEach((token) => {
    switch (token.type) {
      case "space": {
        const blanks = Math.max(0, (token.raw.match(/\n/g)?.length ?? 0) - 1)
        for (let index = 0; index < blanks; index += 1) lines.push([])
        return
      }
      case "heading": {
        const heading = token as Tokens.Heading
        const text = inlineChunks(heading.tokens, plain)
          .map((chunk) => chunk.text)
          .join("")
        lines.push([bold(fg(colors.teal)(text))])
        break
      }
      case "paragraph":
        lines.push(...splitChunks(inlineChunks((token as Tokens.Paragraph).tokens, plain)))
        break
      case "text": {
        const text = token as Tokens.Text
        if (text.tokens !== undefined && text.tokens.length > 0)
          lines.push(...splitChunks(inlineChunks(text.tokens, plain)))
        else lines.push(...splitChunks([fg(colors.text)(text.text)]))
        break
      }
      case "code": {
        const code = token as Tokens.Code
        for (const line of highlightLines(code.text, code.lang?.split(/\s/)[0])) {
          lines.push(line.length === 0 ? [] : [fg(colors.text)("    "), ...line])
        }
        break
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote
        for (const line of blockLines(quote.tokens, depth, plain)) {
          lines.push([dim(fg(colors.text)("│ ")), ...line])
        }
        break
      }
      case "list":
        lines.push(...listLines(token as Tokens.List, depth, plain))
        break
      case "hr":
      case "html":
      case "table":
      default:
        lines.push(...splitChunks([fg(colors.text)(token.raw.replace(/\n+$/, ""))]))
        break
    }
    const blanks = trailingBlankLines(token.raw)
    for (let index = 0; index < blanks; index += 1) lines.push([])
  })
  return lines
}

const renderLines = (source: string, plain: boolean): Lines => {
  const tokens = Lexer.lex(source, { gfm: true })
  const lines = blockLines(tokens, 0, plain)
  while (lines.length > 0 && lines[lines.length - 1]!.length === 0) lines.pop()
  return lines
}

export const renderMarkdown = (source: string): string =>
  renderLines(source, true)
    .map((line) => line.map((chunk) => chunk.text).join(""))
    .join("\n")

export const renderMarkdownStyled = (source: string): StyledText => {
  const chunks: Array<TextChunk> = []
  renderLines(source, false).forEach((line, index) => {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    chunks.push(...line)
  })
  if (chunks.length === 0) chunks.push(fg(colors.text)(""))
  return new StyledText(chunks)
}
