const outputLimit = 12

const bounded = (text: string, width: number): string => {
  const lines = text.split("\n")
  const visible = lines
    .slice(0, outputLimit)
    .map((line) => (line.length <= width ? line : width <= 1 ? "…" : `${line.slice(0, width - 1)}…`))
  if (lines.length > outputLimit) visible.push(`… ${lines.length - outputLimit} lines omitted`)
  return visible.join("\n  ")
}

export const renderTool = (
  tool: {
    readonly name: string
    readonly input: string
    readonly output?: string
    readonly status: string
    readonly expanded?: boolean
  },
  width: number,
): string => {
  const icon = tool.status === "running" ? "⠿" : tool.status === "complete" ? "✓" : "✗"
  const status = tool.status === "running" ? "running" : tool.status === "complete" ? "succeeded" : "failed"
  const detail =
    tool.output === undefined ? tool.input : `${tool.input}\n  ${bounded(tool.output, Math.max(1, width - 2))}`
  return tool.expanded ? `${icon} ${tool.name} [${status}] ▾\n  ${detail}` : `${icon} ${tool.name} [${status}] ▸`
}
