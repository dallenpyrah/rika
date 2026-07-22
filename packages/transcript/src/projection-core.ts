import { Catalog } from "@rika/tools"
import { Function, Option, Schema } from "effect"
import { partialInputRecord } from "./partial-input"
import type { Block, Content, Presentation, Projection, SourceEvent, ToolFile, Unit } from "./schema"

export * from "./schema"
export { pricingVersion } from "./model-cost"
export { partialInputRecord } from "./partial-input"

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const string = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback)

const sourcePayload = (event: SourceEvent): Record<string, unknown> => event.data ?? record(event.content?.[0])

const callPayload = (event: SourceEvent): Record<string, unknown> => {
  const value = sourcePayload(event)
  return value.type === "tool-call" ? record(value.call) : value
}

const resultPayload = (event: SourceEvent): Record<string, unknown> => {
  const value = sourcePayload(event)
  return value.type === "tool-result" ? record(value.result) : value
}

const encodeInput = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value ?? {}))

const outputText = (output: unknown): string => {
  if (typeof output === "string") return output
  const value = record(output)
  if (typeof value.text === "string") return value.text
  return JSON.stringify(output)
}

const eventId = (turnId: string, id: string): string => (turnId.length === 0 ? id : `${turnId}:${id}`)

const executionKey = (value: string): string => value.replace(/^execution:/, "")

const rawToolId = (event: SourceEvent): string => {
  const value = event.type === "tool.result.received" ? resultPayload(event) : callPayload(event)
  return string(value.tool_call_id ?? value.call_id ?? value.callId ?? value.id, event.cursor)
}

const toolKey = (turnId: string, id: string): string => `tool:${eventId(turnId, id)}`

const unit = (
  key: string,
  turnId: string,
  sequence: number,
  part: number,
  revision: number,
  content: Content,
): Unit => ({ key, turnId, order: { sequence, part }, revision, content })

const replaceUnit = (projection: Projection, index: number, next: Unit): Projection => {
  const units = [...projection.units]
  units[index] = next
  return { ...projection, units }
}

const applyExecutionOutcome = (
  projection: Projection,
  turnId: string,
  revision: number,
  outcome: NonNullable<Unit["executionOutcome"]>,
): Projection => {
  const index = projection.units.findIndex(
    (candidate) =>
      candidate.turnId === turnId &&
      candidate.parentId === undefined &&
      candidate.content._tag === "Entry" &&
      candidate.content.role === "user",
  )
  if (index >= 0)
    return replaceUnit(projection, index, { ...projection.units[index]!, revision, executionOutcome: outcome })
  return upsertUnit(projection, {
    ...unit(`execution:${turnId}:outcome`, turnId, Number.MAX_SAFE_INTEGER, 0, revision, {
      _tag: "Entry",
      role: "notice",
      text: "",
    }),
    executionOutcome: outcome,
  })
}

const upsertUnit = (projection: Projection, incoming: Unit): Projection => {
  const index = projection.units.findIndex((candidate) => candidate.key === incoming.key)
  if (index < 0) return { ...projection, units: [...projection.units, incoming] }
  return replaceUnit(projection, index, { ...incoming, order: projection.units[index]!.order })
}

const lineCounts = (patch: string): { readonly additions: number; readonly deletions: number } => {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  return { additions, deletions }
}

const normalizedDiffPath = (value: string): string => value.replace(/^(?:a|b)\//, "")

const unifiedFiles = (callId: string, diff: string, failed: boolean): ReadonlyArray<ToolFile> => {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index ?? 0)
  const ranges = starts.length === 0 ? [0] : starts
  return ranges.flatMap((start, ordinal) => {
    const end = ranges[ordinal + 1] ?? diff.length
    const patch = diff.slice(start, end).trimEnd()
    const oldPath = /^--- (.+)$/m.exec(patch)?.[1]
    const newPath = /^\+\+\+ (.+)$/m.exec(patch)?.[1]
    if (oldPath === undefined && newPath === undefined) return []
    const created = oldPath === "/dev/null" || /new file mode/m.test(patch)
    const deleted = newPath === "/dev/null" || /deleted file mode/m.test(patch)
    const path = normalizedDiffPath(deleted ? oldPath! : newPath!)
    const previousPath = oldPath === undefined || oldPath === "/dev/null" ? undefined : normalizedDiffPath(oldPath)
    const kind = created ? "add" : deleted ? "delete" : previousPath !== path ? "move" : "update"
    return [
      {
        key: `${callId}:${ordinal}`,
        path,
        kind,
        patch,
        ...lineCounts(patch),
        preview: false,
        status: failed ? "failed" : "complete",
        ...(kind === "move" && previousPath !== undefined ? { previousPath } : {}),
      } satisfies ToolFile,
    ]
  })
}

const inputRecord = (input: string): Record<string, unknown> => {
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(input)
  if (Option.isNone(decoded)) return partialInputRecord(input)
  return typeof decoded.value === "string" ? { path: decoded.value, command: decoded.value } : record(decoded.value)
}

const inputString = (input: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
  for (const key of keys) if (typeof input[key] === "string" && input[key].length > 0) return input[key]
  return undefined
}

const inputContentText = (input: Record<string, unknown>): string | undefined => {
  if (!Array.isArray(input.input)) return undefined
  const text = input.input
    .flatMap((part) => {
      const value = record(part)
      return value.type === "text" && typeof value.text === "string" ? [value.text] : []
    })
    .join("\n")
  return text.length === 0 ? undefined : text
}

const detailFor = (name: string, inputText: string): string => {
  const normalizedName = name.toLowerCase()
  const input = inputRecord(inputText)
  const path = inputString(input, ["path", "file_path", "file"])
  if (normalizedName === "read") {
    const readRange = Array.isArray(input.read_range) ? input.read_range : undefined
    if (typeof readRange?.[0] === "number" && typeof readRange[1] === "number")
      return `${path ?? name} L${readRange[0]}-${readRange[1]}`
    const offset = typeof input.offset === "number" ? input.offset : 1
    const limit = typeof input.limit === "number" ? input.limit : undefined
    return `${path ?? name}${limit === undefined ? "" : ` L${offset}-${offset + Math.max(0, limit - 1)}`}`
  }
  if (normalizedName === "grep")
    return `${path === undefined ? "" : `${path} `}"${inputString(input, ["pattern"]) ?? ""}"`.trim()
  if (normalizedName === "bash") {
    const command = inputString(input, ["command", "cmd", "script"]) ?? ""
    const args = Array.isArray(input.args)
      ? input.args.filter((value): value is string => typeof value === "string")
      : []
    return [command, ...args].join(" ").trim()
  }
  if (normalizedName === "shell_command_status") return inputString(input, ["processId", "process_id"]) ?? ""
  if (normalizedName === "web_search") return inputString(input, ["objective", "query"]) ?? ""
  if (normalizedName === "read_web_page") return inputString(input, ["url"]) ?? ""
  if (normalizedName === "find_thread") return inputString(input, ["query"]) ?? ""
  if (normalizedName === "read_thread") return inputString(input, ["threadId", "thread_id", "id"]) ?? ""
  if (path !== undefined) return path
  return inputString(input, ["description", "prompt", "task", "query", "objective"]) ?? inputContentText(input) ?? ""
}

const inputFiles = (id: string, name: string, inputText: string): ReadonlyArray<ToolFile> => {
  const input = inputRecord(inputText)
  const path = inputString(input, ["path", "file_path", "file"])
  if (path === undefined || (name !== "write" && name !== "edit")) return []
  const patch =
    name === "write"
      ? `--- /dev/null\n+++ b/${path}\n${string(input.content)
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`
      : `--- a/${path}\n+++ b/${path}\n${string(input.old_str ?? input.oldText)
          .split("\n")
          .map((line) => `-${line}`)
          .join("\n")}\n${string(input.new_str ?? input.newText)
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`
  return [
    {
      key: `${id}:0`,
      path,
      kind: name === "write" ? "add" : "update",
      patch,
      ...lineCounts(patch),
      preview: true,
      status: "running",
    },
  ]
}

const toolBlock = (id: string, name: string, input: string, previous?: Extract<Block, { _tag: "ToolCall" }>) => ({
  _tag: "ToolCall" as const,
  id,
  name,
  input,
  status: previous?.status ?? ("running" as const),
  presentation: previous?.presentation ?? Catalog.resolvePresentation(name),
  detail: detailFor(name, input),
  files: inputFiles(id, name, input),
  ...(previous?.output === undefined ? {} : { output: previous.output }),
  ...(previous?.process === undefined ? {} : { process: previous.process }),
  ...(previous?.parentId === undefined ? {} : { parentId: previous.parentId }),
  ...(previous?.childId === undefined ? {} : { childId: previous.childId }),
})

const toolIndex = (projection: Projection, id: string): number =>
  projection.units.findIndex(
    (candidate) =>
      candidate.content._tag === "Block" &&
      candidate.content.block._tag === "ToolCall" &&
      candidate.content.block.id === id,
  )

const toolAt = (projection: Projection, id: string): Extract<Block, { _tag: "ToolCall" }> | undefined => {
  const index = toolIndex(projection, id)
  const content = index < 0 ? undefined : projection.units[index]?.content
  return content?._tag === "Block" && content.block._tag === "ToolCall" ? content.block : undefined
}

const childToolAt = (projection: Projection, childId: string): Extract<Block, { _tag: "ToolCall" }> | undefined =>
  projection.units
    .map((candidate) => (candidate.content._tag === "Block" ? candidate.content.block : undefined))
    .find(
      (block): block is Extract<Block, { readonly _tag: "ToolCall" }> =>
        block?._tag === "ToolCall" &&
        block.childId !== undefined &&
        executionKey(block.childId) === executionKey(childId),
    )

const childToolCallId = (childId: string): string | undefined => {
  const marker = ":child:"
  const index = childId.lastIndexOf(marker)
  return index < 0 ? undefined : childId.slice(index + marker.length)
}

const durableToolCallPrefix = /^rika:([^:]+):/

const providerCallId = (id: string): string => {
  const match = durableToolCallPrefix.exec(id)
  if (match === null) return id
  try {
    const namespace = decodeURIComponent(match[1]!)
    return namespace.startsWith("execution:") || namespace.startsWith("child:") || namespace.startsWith("workflow:")
      ? id.slice(match[0].length)
      : id
  } catch {
    return id
  }
}

const childScopeAndCallId = (
  childExecutionId: string,
): { readonly scope: string; readonly callId: string } | undefined => {
  if (childExecutionId.startsWith("child:")) {
    const separator = childExecutionId.indexOf(":", "child:".length)
    if (separator < 0) return undefined
    try {
      return {
        scope: executionKey(decodeURIComponent(childExecutionId.slice("child:".length, separator))),
        callId: providerCallId(childExecutionId.slice(separator + 1)),
      }
    } catch {
      return undefined
    }
  }
  const key = executionKey(childExecutionId)
  const marker = ":child:"
  const index = key.lastIndexOf(marker)
  return index < 0
    ? undefined
    : { scope: key.slice(0, index), callId: providerCallId(key.slice(index + marker.length)) }
}

const candidateCallId = (candidate: ChildParentCandidate): string => {
  const prefix = `${executionKey(candidate.scope)}:`
  const id = executionKey(candidate.id)
  return providerCallId(id.startsWith(prefix) ? id.slice(prefix.length) : id)
}

export interface ChildParentCandidate {
  readonly id: string
  readonly scope: string
  readonly childId: string | undefined
  readonly family: Presentation["family"]
}

export const childParentMatch: {
  <A extends ChildParentCandidate>(childExecutionId: string): (candidates: Iterable<A>) => A | undefined
  <A extends ChildParentCandidate>(candidates: Iterable<A>, childExecutionId: string): A | undefined
} = Function.dual(
  2,
  <A extends ChildParentCandidate>(candidates: Iterable<A>, childExecutionId: string): A | undefined => {
    const childKey = executionKey(childExecutionId)
    const list = [...candidates]
    for (const candidate of list)
      if (candidate.childId !== undefined && executionKey(candidate.childId) === childKey) return candidate
    const parsed = childScopeAndCallId(childExecutionId)
    if (parsed === undefined) return undefined
    for (const candidate of list)
      if (
        candidate.family === "agent" &&
        executionKey(candidate.scope) === parsed.scope &&
        candidateCallId(candidate) === parsed.callId
      )
        return candidate
    return undefined
  },
)

const agentPresentationFor = (name: string): Presentation => {
  const profile = name.toLowerCase()
  return Catalog.resolvePresentation(
    profile === "task" || profile === "child" || profile === "subagent"
      ? "task"
      : profile === "oracle" || profile === "librarian"
        ? profile
        : `transfer_to_${profile}`,
  )
}

export const ensureChildTool: {
  (childExecutionId: string, name: string): (projection: Projection) => ChildToolResult
  (projection: Projection, childExecutionId: string, name: string): ChildToolResult
} = Function.dual(3, (projection: Projection, childExecutionId: string, name: string): ChildToolResult => {
  const existing = childToolAt(projection, childExecutionId)
  if (existing !== undefined) return { projection, tool: existing }
  const id = executionKey(childExecutionId)
  const block: Extract<Block, { _tag: "ToolCall" }> = {
    _tag: "ToolCall",
    id,
    name,
    input: "",
    status: "running",
    presentation: agentPresentationFor(name),
    detail: "",
    files: [],
    childId: childExecutionId,
  }
  const turnId = projection.units[0]?.turnId ?? ""
  const next = upsertUnit(
    projection,
    unit(`tool:${id}`, turnId, projection.revision, 0, projection.revision, { _tag: "Block", block }),
  )
  return { projection: next, tool: block }
})

type ChildToolResult = { readonly projection: Projection; readonly tool: Extract<Block, { _tag: "ToolCall" }> }

const updateTool = (
  projection: Projection,
  id: string,
  sequence: number,
  update: (tool: Extract<Block, { _tag: "ToolCall" }>) => Extract<Block, { _tag: "ToolCall" }>,
): Projection => {
  const index = toolIndex(projection, id)
  const current = index < 0 ? undefined : projection.units[index]
  if (current?.content._tag !== "Block" || current.content.block._tag !== "ToolCall") return projection
  return replaceUnit(projection, index, {
    ...current,
    revision: sequence,
    content: { _tag: "Block", block: update(current.content.block) },
  })
}

export const internal = {
  record,
  string,
  sourcePayload,
  callPayload,
  resultPayload,
  encodeInput,
  outputText,
  eventId,
  executionKey,
  rawToolId,
  toolKey,
  unit,
  replaceUnit,
  applyExecutionOutcome,
  upsertUnit,
  lineCounts,
  normalizedDiffPath,
  unifiedFiles,
  inputRecord,
  inputString,
  inputContentText,
  detailFor,
  inputFiles,
  toolBlock,
  toolIndex,
  toolAt,
  childToolAt,
  childToolCallId,
  durableToolCallPrefix,
  providerCallId,
  childScopeAndCallId,
  candidateCallId,
  agentPresentationFor,
  updateTool,
}
