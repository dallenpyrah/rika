import { Function } from "effect"

const outputLimit = 12

const bounded = (text: string, width: number): string => {
  const lines = text.split("\n")
  const clipLine = (line: string): string => {
    if (line.length <= width) return line
    if (width <= 1) return "…"
    return `${line.slice(0, width - 1)}…`
  }
  const visible = lines.slice(0, outputLimit).map(clipLine)
  if (lines.length > outputLimit) visible.push(`… ${lines.length - outputLimit} lines omitted`)
  return visible.join("\n  ")
}

type Tool = {
  readonly name: string
  readonly input: string
  readonly output?: string
  readonly status: string
  readonly expanded?: boolean
}

export const renderTool: {
  (width: number): (tool: Tool) => string
  (tool: Tool, width: number): string
} = Function.dual(2, (tool: Tool, width: number): string => {
  let icon: string
  let status: string
  if (tool.status === "running") {
    icon = "⠿"
    status = "running"
  } else if (tool.status === "complete") {
    icon = "✓"
    status = "succeeded"
  } else if (tool.status === "cancelled") {
    icon = "⊘"
    status = "cancelled"
  } else {
    icon = "✗"
    status = "failed"
  }
  const detail =
    tool.output === undefined ? tool.input : `${tool.input}\n  ${bounded(tool.output, Math.max(1, width - 2))}`
  return tool.expanded === true
    ? `${icon} ${tool.name} [${status}] ▾\n  ${detail}`
    : `${icon} ${tool.name} [${status}] ▸`
})
