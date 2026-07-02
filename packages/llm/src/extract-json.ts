export const extractJson = (content: string) => {
  const trimmed = content.trim()
  if (!trimmed.startsWith("```")) return trimmed
  const firstLineEnd = trimmed.indexOf("\n")
  const lastFenceStart = trimmed.lastIndexOf("```")
  if (firstLineEnd < 0 || lastFenceStart <= firstLineEnd) return trimmed
  return trimmed.slice(firstLineEnd + 1, lastFenceStart).trim()
}
