import { Catalog } from "@rika/tools"
import { Function } from "effect"
import { pricingVersion, usageCostUsd } from "./model-cost"
import type { Block, Projection, SourceEvent, ToolProcess, Unit } from "./schema"
import { internal as Core } from "./projection-core"

const processResult = (output: unknown): ToolProcess | undefined => {
  const value = Core.record(output)
  const process = {
    ...(typeof value.running === "boolean" ? { running: value.running } : {}),
    ...(typeof value.processId === "string" ? { processId: value.processId } : {}),
    ...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
    ...(typeof value.stdout === "string" ? { stdout: value.stdout } : {}),
    ...(typeof value.stderr === "string" ? { stderr: value.stderr } : {}),
    ...(typeof value.truncated === "boolean" ? { truncated: value.truncated } : {}),
  }
  return Object.keys(process).length === 0 ? undefined : process
}

const usageCost = (value: Record<string, unknown>): number | undefined => usageCostUsd(value)

const applyUsage = (projection: Projection, event: SourceEvent): Projection => {
  if ((projection.usageCursors ?? []).includes(event.cursor)) return projection
  const cost = usageCost(Core.sourcePayload(event))
  if (cost === undefined) return projection
  return {
    ...projection,
    costUsd: (projection.costUsd ?? 0) + cost,
    usageCursors: [...(projection.usageCursors ?? []), event.cursor],
    ...(projection.costUsd === undefined || projection.pricingVersion === pricingVersion ? { pricingVersion } : {}),
  }
}

const assistantKey = (turnId: string, phase: number): string => `assistant:${turnId}:${Math.max(0, phase)}`
const reasoningKey = (turnId: string, phase: number): string => `reasoning:${turnId}:${Math.max(0, phase)}`

const assistantText = (event: SourceEvent): string => event.text ?? Core.string(Core.sourcePayload(event).text)

const applyAssistant = (projection: Projection, turnId: string, event: SourceEvent, complete: boolean): Projection => {
  const key = assistantKey(turnId, projection.modelPhase)
  const index = projection.units.findIndex((candidate) => candidate.key === key)
  const current = index < 0 ? undefined : projection.units[index]
  const text = assistantText(event)
  const finish = (next: Projection) =>
    complete && text.trim().length > 0 ? { ...next, usableCompletionSequence: event.sequence } : next
  const aggregateCompletion = complete && typeof Core.sourcePayload(event).model_output === "string"
  if (aggregateCompletion) {
    const hasAssistant = projection.units.some(
      (candidate) => candidate.content._tag === "Entry" && candidate.content.role === "assistant",
    )
    if (hasAssistant)
      return finish(
        current?.content._tag === "Entry" && current.content.role === "assistant"
          ? Core.replaceUnit(projection, index, { ...current, revision: event.sequence })
          : projection,
      )
  }
  if (current?.content._tag === "Entry" && current.content.role === "assistant")
    return finish(
      Core.replaceUnit(projection, index, {
        ...current,
        revision: event.sequence,
        content: {
          ...current.content,
          text: complete && text.length > 0 ? text : current.content.text + text,
        },
      }),
    )
  if (text.length === 0) return projection
  return finish(
    Core.upsertUnit(
      projection,
      Core.unit(key, turnId, event.sequence, 0, event.sequence, { _tag: "Entry", role: "assistant", text }),
    ),
  )
}

const childStatus = (
  event: SourceEvent,
  value: Record<string, unknown>,
): "running" | "complete" | "failed" | "cancelled" => {
  const raw = Core.string(value.status ?? value.state).toLowerCase()
  if (raw === "failed" || raw === "error") return "failed"
  if (raw === "cancelled" || raw === "canceled") return "cancelled"
  if (raw === "completed" || raw === "complete" || raw === "succeeded" || raw === "terminal") return "complete"
  if (event.type.includes("failed")) return "failed"
  if (event.type.includes("cancel")) return "cancelled"
  if (event.type.includes("terminal") || event.type.includes("completed")) return "complete"
  return "running"
}

const applyChild = (projection: Projection, turnId: string, event: SourceEvent): Projection => {
  const outer = Core.sourcePayload(event)
  const value = Object.keys(Core.record(outer.member)).length > 0 ? Core.record(outer.member) : outer
  const childId = Core.string(
    value.child_execution_id ??
      value.child_run_id ??
      value.childId ??
      value.child_id ??
      outer.child_execution_id ??
      outer.child_run_id ??
      outer.childId,
    event.cursor,
  )
  const correlatedToolId = Core.string(value.tool_call_id ?? value.parent_tool_call_id)
  const encodedToolId = Core.childToolCallId(childId)
  const linkedTool =
    correlatedToolId.length > 0
      ? Core.toolAt(projection, Core.eventId(turnId, correlatedToolId))
      : (Core.childToolAt(projection, childId) ??
        (encodedToolId === undefined ? undefined : Core.toolAt(projection, Core.eventId(turnId, encodedToolId))))
  if (linkedTool !== undefined) {
    const id = linkedTool.id
    const childState = childStatus(event, value)
    const profile = Core.string(value.profile ?? value.preset_name ?? value.name).toLowerCase()
    const presentation =
      profile.length === 0
        ? linkedTool.presentation
        : Catalog.resolvePresentation(
            profile === "task" || profile === "child" || profile === "subagent"
              ? "task"
              : profile === "oracle" || profile === "librarian"
                ? profile
                : `transfer_to_${profile}`,
          )
    const updated = Core.updateTool(projection, id, event.sequence, (tool) => ({
      ...tool,
      childId,
      status: childState,
      presentation,
      ...(Core.string(value.summary ?? value.output ?? value.error).length === 0
        ? {}
        : { output: Core.string(value.summary ?? value.output ?? value.error) }),
    }))
    if (updated !== projection)
      return {
        ...updated,
        units: updated.units.filter((candidate) => {
          const block = candidate.content._tag === "Block" ? candidate.content.block : undefined
          return block?._tag !== "ChildAgent" || Core.executionKey(block.id) !== Core.executionKey(childId)
        }),
      }
  }
  const key = `child:${Core.eventId(turnId, childId)}`
  const current = projection.units.find((candidate) => candidate.key === key)
  const previous =
    current?.content._tag === "Block" && current.content.block._tag === "ChildAgent" ? current.content.block : undefined
  const activity = Core.string(value.activity ?? value.event ?? value.detail ?? event.text)
  const block: Extract<Block, { _tag: "ChildAgent" }> = {
    _tag: "ChildAgent",
    id: childId,
    name: Core.string(value.profile ?? value.preset_name ?? value.name, previous?.name ?? "child"),
    summary: Core.string(value.summary ?? value.output ?? value.error, previous?.summary ?? ""),
    status: childStatus(event, value),
    activity: activity.length === 0 ? (previous?.activity ?? []) : [...(previous?.activity ?? []), activity],
  }
  return Core.upsertUnit(
    projection,
    Core.unit(key, turnId, current?.order.sequence ?? event.sequence, 0, event.sequence, { _tag: "Block", block }),
  )
}

const genericBlock = (turnId: string, event: SourceEvent): Block | undefined => {
  const value = Core.sourcePayload(event)
  if (event.type === "tool.approval.requested" || event.type === "tool.approval.resolved")
    return {
      _tag: "Permission",
      id: Core.string(value.wait_id, event.cursor),
      kind: "tool-approval",
      title: Core.string(value.tool_name, "Permission required"),
      detail: Core.encodeInput(value.input),
      status: event.type === "tool.approval.requested" ? "pending" : value.approved === false ? "denied" : "approved",
    }
  if (event.type === "permission.ask.requested" || event.type === "permission.ask.resolved")
    return {
      _tag: "Permission",
      id: Core.string(value.wait_id ?? value.permission_id, event.cursor),
      kind: "permission",
      title: Core.string(value.title ?? value.tool_name ?? value.name, "Permission required"),
      detail: Core.encodeInput(value.input),
      status: event.type === "permission.ask.requested" ? "pending" : value.approved === false ? "denied" : "approved",
    }
  if (event.type.includes("diff"))
    return {
      _tag: "Diff",
      path: Core.string(value.path, "diff"),
      patch: event.text ?? Core.string(value.patch ?? value.diff),
    }
  if (event.type.includes("compact"))
    return {
      _tag: "Compaction",
      summary: event.text ?? Core.string(value.summary),
      ...(Core.string(value.checkpoint ?? value.checkpoint_id).length === 0
        ? {}
        : { checkpoint: Core.string(value.checkpoint ?? value.checkpoint_id) }),
    }
  if (event.type.includes("notification"))
    return {
      _tag: "Notification",
      title: Core.string(value.title ?? value.name, "Notification"),
      detail: event.text ?? Core.string(value.detail ?? value.message),
    }
  if (event.type.includes("image") && event.type.includes("attachment"))
    return {
      _tag: "ImageAttachment",
      name: Core.string(value.name ?? value.filename, "image"),
      mediaType: Core.string(value.media_type ?? value.mediaType, "application/octet-stream"),
      ...(typeof value.width === "number" ? { width: value.width } : {}),
      ...(typeof value.height === "number" ? { height: value.height } : {}),
      ...(typeof value.bytes === "number" ? { bytes: value.bytes } : {}),
    }
  if (event.type.includes("workflow"))
    return {
      _tag: "Workflow",
      name: Core.string(value.workflow ?? value.name, "workflow"),
      step: event.text ?? Core.string(value.step ?? value.status),
      status: event.type.includes("failed")
        ? "failed"
        : event.type.includes("completed")
          ? "complete"
          : event.type.includes("wait")
            ? "waiting"
            : "running",
    }
  if (event.type.includes("error") || event.type.includes("failed") || event.type === "budget.exceeded")
    return {
      _tag: "Error",
      title: Core.string(value.title, event.type === "budget.exceeded" ? "Budget exceeded" : "Error"),
      detail: event.text ?? Core.string(value.message ?? value.error, event.type),
      turnId,
      ...(Core.string(value.recovery).length === 0 ? {} : { recovery: Core.string(value.recovery) }),
    }
  if (event.type.includes("tool") && (event.type.includes("result") || event.type.includes("completed")))
    return {
      _tag: "ToolResult",
      id: Core.eventId(turnId, Core.string(value.callId ?? value.call_id ?? value.id, event.cursor)),
      output: event.text ?? Core.string(value.output ?? value.result),
      failed: event.type.includes("failed") || value.failed === true,
    }
  if (event.type.includes("tool")) {
    const id = Core.eventId(turnId, Core.string(value.callId ?? value.call_id ?? value.id, event.cursor))
    const name = Core.string(value.name ?? value.tool, "tool")
    const input = Core.encodeInput(value.input ?? value)
    return Core.toolBlock(id, name, input)
  }
  return undefined
}

const genericKey = (turnId: string, event: SourceEvent, block: Block): string => {
  const value = Core.sourcePayload(event)
  switch (block._tag) {
    case "Diff":
      return `diff:${Core.eventId(turnId, block.path)}`
    case "Compaction":
      return `compaction:${turnId}`
    case "Permission":
      return `permission:${Core.eventId(turnId, block.id)}`
    case "ChildAgent":
      return `child:${Core.eventId(turnId, block.id)}`
    case "Workflow":
      return `workflow:${Core.eventId(turnId, Core.string(value.run_id ?? value.runId ?? value.workflow_id, block.name))}`
    case "ImageAttachment":
      return `image:${Core.eventId(turnId, Core.string(value.id, block.name))}`
    case "Notification":
      return `notification:${Core.eventId(turnId, Core.string(value.id, block.title))}`
    case "Error":
      return `error:${Core.eventId(turnId, Core.string(value.id, event.type))}`
    default: {
      const id = "id" in block && typeof block.id === "string" ? block.id : `${event.sequence}:${event.type}`
      return `event:${Core.eventId(turnId, id)}`
    }
  }
}

export const empty: {
  (turnId: string, prompt: string): Projection
  (prompt: string): (turnId: string) => Projection
} = Function.dual(
  2,
  (turnId: string, prompt: string): Projection => ({
    units: [Core.unit(`turn:${turnId}:user`, turnId, -1, 0, 0, { _tag: "Entry", role: "user", text: prompt })],
    revision: -1,
    modelPhase: -1,
  }),
)

const applyToolDelta = (projection: Projection, turnId: string, event: SourceEvent): Projection => {
  const value = Core.callPayload(event)
  const rawId = Core.rawToolId(event)
  const id = Core.eventId(turnId, rawId)
  const previous = Core.toolAt(projection, id)
  const delta = Core.string(value.delta ?? event.text)
  const input = `${previous?.input ?? ""}${delta}`
  const name = Core.string(value.tool_name ?? value.name, previous?.name ?? "tool")
  const block = Core.toolBlock(id, name, input, previous)
  return Core.upsertUnit(
    projection,
    Core.unit(Core.toolKey(turnId, rawId), turnId, event.sequence, 0, event.sequence, { _tag: "Block", block }),
  )
}

const applyToolRequested = (projection: Projection, turnId: string, event: SourceEvent): Projection => {
  const value = Core.callPayload(event)
  const rawId = Core.rawToolId(event)
  const id = Core.eventId(turnId, rawId)
  const name = Core.string(value.tool_name ?? value.name, Core.toolAt(projection, id)?.name ?? "tool")
  const input = Core.encodeInput(value.input)
  const previous = Core.toolAt(projection, id)
  const base = Core.toolBlock(id, name, input, previous)
  const processId =
    name === "shell_command_status" ? Core.inputString(Core.inputRecord(input), ["processId", "process_id"]) : undefined
  const parent =
    processId === undefined
      ? undefined
      : projection.units.find((candidate) => {
          if (candidate.content._tag !== "Block" || candidate.content.block._tag !== "ToolCall") return false
          return candidate.content.block.name === "bash" && candidate.content.block.process?.processId === processId
        })
  const block =
    parent?.content._tag === "Block" && parent.content.block._tag === "ToolCall"
      ? { ...base, detail: parent.content.block.detail, parentId: parent.content.block.id }
      : base
  return Core.upsertUnit(
    projection,
    Core.unit(Core.toolKey(turnId, rawId), turnId, event.sequence, 0, event.sequence, { _tag: "Block", block }),
  )
}

const applyToolResult = (projection: Projection, turnId: string, event: SourceEvent): Projection => {
  const value = Core.resultPayload(event)
  const id = Core.eventId(turnId, Core.rawToolId(event))
  const output = value.output
  const outputStatus = Core.string(Core.record(output).status).toLowerCase()
  const process = processResult(output)
  const failed =
    typeof value.error === "string" ||
    Core.record(output)._tag === "ToolError" ||
    outputStatus === "failed" ||
    (process?.exitCode !== undefined && process.exitCode !== 0)
  const cancelled = outputStatus === "cancelled" || outputStatus === "canceled"
  const errorText = Core.string(value.error, Core.string(Core.record(output).message))
  const resultText = failed && errorText.length > 0 ? errorText : Core.outputText(output)
  const diff = Core.string(Core.record(output).diff)
  const updated = Core.updateTool(projection, id, event.sequence, (tool) => ({
    ...tool,
    status: failed ? "failed" : cancelled ? "cancelled" : process?.running === true ? "running" : "complete",
    output: resultText,
    ...(process === undefined ? {} : { process: { ...tool.process, ...process } }),
    files:
      diff.length > 0
        ? Core.unifiedFiles(id, diff, failed)
        : tool.files.map((file) => ({ ...file, preview: false, status: failed ? "failed" : "complete" })),
  }))
  if (updated !== projection) return updated
  const result: Block = { _tag: "ToolResult", id, output: resultText, failed }
  return Core.upsertUnit(
    projection,
    Core.unit(`tool-result:${id}`, turnId, event.sequence, 0, event.sequence, { _tag: "Block", block: result }),
  )
}

const applyReasoning = (projection: Projection, turnId: string, event: SourceEvent): Projection => {
  const key = reasoningKey(turnId, projection.modelPhase)
  const current = projection.units.find((candidate) => candidate.key === key)
  const previous =
    current?.content._tag === "Block" && current.content.block._tag === "Reasoning" ? current.content.block.text : ""
  const block: Block = {
    _tag: "Reasoning",
    text: previous + (event.text ?? Core.string(Core.sourcePayload(event).text)),
  }
  return Core.upsertUnit(
    projection,
    Core.unit(key, turnId, current?.order.sequence ?? event.sequence, 0, event.sequence, { _tag: "Block", block }),
  )
}

const settledBlock = (block: Block, status: "failed" | "cancelled"): Block | undefined => {
  if (block._tag === "ToolCall" && block.status === "running") return { ...block, status }
  if (block._tag === "ChildAgent" && block.status === "running") return { ...block, status }
  return undefined
}

const settleRunningImpl = (projection: Projection, status: "failed" | "cancelled", sequence: number): Projection => {
  let changed = false
  const units = projection.units.map((candidate) => {
    if (candidate.content._tag !== "Block") return candidate
    const settled = settledBlock(candidate.content.block, status)
    if (settled === undefined) return candidate
    changed = true
    return {
      ...candidate,
      revision: Math.max(candidate.revision, sequence),
      content: { _tag: "Block" as const, block: settled },
    }
  })
  return changed ? { ...projection, units } : projection
}

export const settleRunning: {
  (projection: Projection, status: "failed" | "cancelled", sequence: number): Projection
  (status: "failed" | "cancelled", sequence: number): (projection: Projection) => Projection
} = Function.dual(3, settleRunningImpl)

const toolUnitRevision = (projection: Projection, id: string): number => {
  const index = Core.toolIndex(projection, id)
  return index < 0 ? -1 : projection.units[index]!.revision
}

const settleChildImpl = (
  projection: Projection,
  childId: string,
  status: "complete" | "failed" | "cancelled",
  sequence: number,
): Projection => {
  const turnId = projection.units[0]?.turnId ?? ""
  const encodedToolId = Core.childToolCallId(childId)
  const linkedTool =
    Core.childToolAt(projection, childId) ??
    (encodedToolId === undefined ? undefined : Core.toolAt(projection, Core.eventId(turnId, encodedToolId)))
  const settledTool =
    linkedTool === undefined || linkedTool.status !== "running"
      ? projection
      : Core.updateTool(
          projection,
          linkedTool.id,
          Math.max(sequence, toolUnitRevision(projection, linkedTool.id)),
          (tool) => ({ ...tool, status }),
        )
  let changed = settledTool !== projection
  const units = settledTool.units.map((candidate) => {
    if (candidate.content._tag !== "Block") return candidate
    const block = candidate.content.block
    if (block._tag !== "ChildAgent" || Core.executionKey(block.id) !== Core.executionKey(childId)) return candidate
    if (block.status !== "running") return candidate
    changed = true
    return {
      ...candidate,
      revision: Math.max(candidate.revision, sequence),
      content: { _tag: "Block" as const, block: { ...block, status } },
    }
  })
  return changed ? { ...settledTool, units } : projection
}

export const settleChild: {
  (projection: Projection, childId: string, status: "complete" | "failed" | "cancelled", sequence: number): Projection
  (
    childId: string,
    status: "complete" | "failed" | "cancelled",
    sequence: number,
  ): (projection: Projection) => Projection
} = Function.dual(4, settleChildImpl)

export const hasRunningBlocks = (projection: Projection): boolean =>
  projection.units.some(
    (candidate) =>
      candidate.content._tag === "Block" &&
      (candidate.content.block._tag === "ToolCall" || candidate.content.block._tag === "ChildAgent") &&
      candidate.content.block.status === "running",
  )

const advanceModelPhase = (projection: Projection, turnId: string): Projection => {
  const phase = Math.max(0, projection.modelPhase)
  const hasOutput = projection.units.some(
    (candidate) => candidate.key === assistantKey(turnId, phase) || candidate.key === reasoningKey(turnId, phase),
  )
  return hasOutput ? { ...projection, modelPhase: phase + 1 } : projection
}

const hasUsableFinalResponse = (projection: Projection, turnId: string) => {
  const latestToolRevision = projection.units.reduce(
    (latest, candidate) =>
      candidate.turnId === turnId && candidate.content._tag === "Block" && candidate.content.block._tag === "ToolCall"
        ? Math.max(latest, candidate.revision)
        : latest,
    -1,
  )
  return projection.usableCompletionSequence !== undefined && projection.usableCompletionSequence > latestToolRevision
}

const applyKnownEvent = (projection: Projection, turnId: string, event: SourceEvent): Projection => {
  if (event.type === "model.input.prepared") {
    if (projection.modelPhase < 0) {
      const advanced = advanceModelPhase({ ...projection, modelPhase: 0 }, turnId)
      return advanced.modelPhase === 0 ? { ...projection, modelPhase: 0 } : advanced
    }
    return advanceModelPhase(projection, turnId)
  }
  if (event.type === "model.output.delta") return applyAssistant(projection, turnId, event, false)
  if (event.type === "model.output.completed") return applyAssistant(projection, turnId, event, true)
  if (event.type.includes("reasoning")) return applyReasoning(projection, turnId, event)
  if (event.type === "model.toolcall.delta") return applyToolDelta(projection, turnId, event)
  if (event.type === "tool.call.requested")
    return advanceModelPhase(applyToolRequested(projection, turnId, event), turnId)
  if (event.type === "tool.result.received") return applyToolResult(projection, turnId, event)
  if (event.type === "model.usage.reported") return applyUsage(projection, event)
  if (event.type === "execution.completed")
    return Core.applyExecutionOutcome(projection, turnId, event.sequence, { status: "complete" })
  if (event.type === "execution.failed") {
    if (hasUsableFinalResponse(projection, turnId))
      return Core.applyExecutionOutcome(
        settleRunningImpl(projection, "cancelled", event.sequence),
        turnId,
        event.sequence,
        {
          status: "complete",
        },
      )
    const reason = event.text ?? Core.string(Core.sourcePayload(event).message, "Execution failed")
    const block: Block = {
      _tag: "Error",
      title: "Execution failed",
      detail: reason,
      turnId,
      recovery: "Edit your prompt and press Enter to try again.",
    }
    return Core.upsertUnit(settleRunningImpl(projection, "failed", event.sequence), {
      ...Core.unit(`execution:${turnId}:failed`, turnId, event.sequence, 0, event.sequence, { _tag: "Block", block }),
      executionOutcome: { status: "failed", reason },
    })
  }
  if (event.type === "execution.cancelled") {
    const payload = Core.sourcePayload(event)
    const reason = event.text ?? Core.string(payload.reason, Core.string(payload.message))
    return Core.upsertUnit(settleRunningImpl(projection, "cancelled", event.sequence), {
      ...Core.unit(`execution:${turnId}:cancelled`, turnId, event.sequence, 0, event.sequence, {
        _tag: "Entry",
        role: "notice",
        text: reason.length > 0 ? reason : "cancelled",
      }),
      executionOutcome: { status: "cancelled", ...(reason.length > 0 ? { reason } : {}) },
    })
  }
  if (event.type.startsWith("child_run.") || event.type.startsWith("child_fan_out.member."))
    return applyChild(projection, turnId, event)
  const block = genericBlock(turnId, event)
  if (block === undefined) return projection
  const updated = Core.upsertUnit(
    projection,
    Core.unit(genericKey(turnId, event, block), turnId, event.sequence, 0, event.sequence, { _tag: "Block", block }),
  )
  return block._tag === "Permission" && block.status === "pending" ? advanceModelPhase(updated, turnId) : updated
}

export const applyEvent: {
  (projection: Projection, event: SourceEvent): Projection
  (event: SourceEvent): (projection: Projection) => Projection
} = Function.dual(2, (projection: Projection, event: SourceEvent): Projection => {
  if (event.sequence <= projection.revision)
    return event.type === "model.usage.reported" ? applyUsage(projection, event) : projection
  const turnId = projection.units[0]?.turnId ?? ""
  const next = applyKnownEvent(projection, turnId, event)
  return {
    ...next,
    revision: event.sequence,
    ...(projection.oldestCursor === undefined ? { oldestCursor: event.cursor } : {}),
    checkpointCursor: event.cursor,
  }
})

export const project: {
  (turnId: string, prompt: string, events: ReadonlyArray<SourceEvent>): Projection
  (prompt: string, events: ReadonlyArray<SourceEvent>): (turnId: string) => Projection
} = Function.dual(3, (turnId: string, prompt: string, events: ReadonlyArray<SourceEvent>): Projection => {
  let projection = empty(turnId, prompt)
  for (const event of events.toSorted((left, right) => left.sequence - right.sequence))
    projection = applyEvent(projection, event)
  return projection
})

export interface NestedProjection {
  readonly parentId: string
  readonly projection: Projection
}

const attachParent = (candidate: Unit, parentId: string): Unit => ({ ...candidate, parentId })
const assignOrder = (candidate: Unit, sequence: number): Unit => ({
  ...candidate,
  order: { sequence, part: 0 },
})

export const withNestedProjections: {
  (root: Projection, nested: ReadonlyArray<NestedProjection>): Projection
  (nested: ReadonlyArray<NestedProjection>): (root: Projection) => Projection
} = Function.dual(2, (root: Projection, nested: ReadonlyArray<NestedProjection>): Projection => {
  const rootTurnId = root.units.find((candidate) => candidate.parentId === undefined)?.turnId ?? root.units[0]?.turnId
  const units = [
    ...root.units.filter((candidate) => candidate.parentId === undefined && candidate.turnId === rootTurnId),
    ...nested.flatMap(({ parentId, projection }) =>
      projection.units.map((candidate) => attachParent(candidate, parentId)),
    ),
  ].map(assignOrder)
  return { ...root, units }
})
