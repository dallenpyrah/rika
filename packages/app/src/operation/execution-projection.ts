import * as Thread from "@rika/persistence/thread"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as Transcript from "@rika/transcript"
import { Effect, Function } from "effect"
import type { InteractiveEvent } from "../operation-contract"
const isTerminalStatus = (status: Turn.Status) =>
  status === "completed" || status === "failed" || status === "cancelled"

const normalizeChildExecutionId = (executionId: string): string => executionId.replace(/^execution:/, "")

const transcriptPatch = (turn: Turn.Turn, event: ExecutionBackend.Event): InteractiveEvent => {
  const executionId = event.data?.execution_id
  const turnId =
    typeof executionId === "string" && executionId.length > 0
      ? Turn.TurnId.make(normalizeChildExecutionId(executionId))
      : turn.id
  return {
    _tag: "TranscriptPatched",
    selectionEpoch: 0,
    threadId: turn.threadId,
    turnId,
    ...(turnId === turn.id || (event.type !== "model.usage.reported" && event.type !== "child_run.spawned")
      ? {}
      : { rootTurnId: turn.id }),
    event,
    revision: event.sequence,
  }
}

const sourceProjection = (projection: TranscriptRepository.Projection): Transcript.Projection => ({
  units: projection.units,
  revision: projection.revision,
  modelPhase: projection.modelPhase,
  ...(projection.oldestCursor === undefined ? {} : { oldestCursor: projection.oldestCursor }),
  ...(projection.checkpointCursor === undefined ? {} : { checkpointCursor: projection.checkpointCursor }),
  ...(projection.costUsd === undefined ? {} : { costUsd: projection.costUsd }),
  ...(projection.usageCursors === undefined ? {} : { usageCursors: projection.usageCursors }),
  ...(projection.pricingVersion === undefined ? {} : { pricingVersion: projection.pricingVersion }),
})

export const rootExecutionEvents: {
  (turnId: string, events: ReadonlyArray<ExecutionBackend.Event>): ReadonlyArray<ExecutionBackend.Event>
  (events: ReadonlyArray<ExecutionBackend.Event>): (turnId: string) => ReadonlyArray<ExecutionBackend.Event>
} = Function.dual(
  2,
  (turnId: string, events: ReadonlyArray<ExecutionBackend.Event>): ReadonlyArray<ExecutionBackend.Event> =>
    events.filter(
      (event) =>
        !event.cursor.startsWith("child:") &&
        (!event.cursor.startsWith("execution:") || event.cursor.startsWith(`execution:${turnId}:`)),
    ),
)

const rootCheckpointCursor = (turnId: string, cursor: string | undefined): string | undefined =>
  cursor === undefined ||
  cursor.startsWith("child:") ||
  (cursor.startsWith("execution:") && !cursor.startsWith(`execution:${turnId}:`))
    ? undefined
    : cursor

const toolForChild = (projection: Transcript.Projection, childExecutionId: string) =>
  Transcript.childParentMatch(
    projection.units.flatMap((unit) =>
      unit.content._tag === "Block" && unit.content.block._tag === "ToolCall"
        ? [
            {
              id: unit.content.block.id,
              scope: unit.turnId,
              childId: unit.content.block.childId,
              family: unit.content.block.presentation.family,
              tool: unit.content.block,
            },
          ]
        : [],
    ),
    childExecutionId,
  )?.tool

const hasMissingNestedProjection = (projection: Transcript.Projection): boolean =>
  projection.units.some((unit) => {
    if (unit.content._tag !== "Block" || unit.content.block._tag !== "ToolCall") return false
    const childId = unit.content.block.childId
    if (childId === undefined) return false
    const parentId = unit.content.block.id
    return !projection.units.some(
      (candidate) =>
        candidate.parentId === parentId &&
        normalizeChildExecutionId(candidate.turnId) === normalizeChildExecutionId(childId) &&
        candidate.revision >= 0,
    )
  })

const replayProjection = Effect.fn("Operation.replayProjection")(function* (
  backend: ExecutionBackend.Interface,
  executionId: string,
) {
  const turnId = normalizeChildExecutionId(executionId)
  if (backend.pageEvents === undefined) {
    const result = yield* backend.replay(executionId, undefined, ExecutionBackend.executionReference)
    return Transcript.project(turnId, "", result.events)
  }
  let projection = Transcript.empty(turnId, "")
  let after: string | undefined
  const cursors = new Set<string>()
  while (true) {
    const page = yield* backend.pageEvents(executionId, "forward", after, 200, ExecutionBackend.executionReference)
    for (const event of page.events.toSorted((left, right) => left.sequence - right.sequence))
      projection = Transcript.applyEvent(projection, event)
    if (!page.hasMore) return projection
    const next = page.newestCursor
    if (next === undefined || cursors.has(next)) return projection
    cursors.add(next)
    after = next
  }
})

const settledChildStatus = (
  status: "accepted" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled",
): "complete" | "failed" | "cancelled" | undefined =>
  status === "completed"
    ? "complete"
    : status === "failed"
      ? "failed"
      : status === "cancelled"
        ? "cancelled"
        : undefined

const projectExecutionTree = Effect.fn("Operation.projectExecutionTree")(function* (
  backend: ExecutionBackend.Interface,
  rootExecutionId: string,
  root: Transcript.Projection,
) {
  const nested: Array<Transcript.NestedProjection> = []
  let rootProjection = root
  const pending: Array<{
    readonly executionId: string
    readonly nestedIndex: number | undefined
    readonly reference: boolean
  }> = [{ executionId: rootExecutionId, nestedIndex: undefined, reference: false }]
  const seen = new Set([normalizeChildExecutionId(rootExecutionId)])
  while (pending.length > 0) {
    const current = pending.shift()!
    const inspection = yield* backend.inspect(
      current.executionId,
      current.reference ? ExecutionBackend.executionReference : undefined,
    )
    if (inspection === undefined) continue
    const parentProjection = () =>
      current.nestedIndex === undefined ? rootProjection : nested[current.nestedIndex]!.projection
    const settleParent = (projection: Transcript.Projection) => {
      if (current.nestedIndex === undefined) rootProjection = projection
      else nested[current.nestedIndex] = { ...nested[current.nestedIndex]!, projection }
    }
    for (const child of inspection.children) {
      const childId = normalizeChildExecutionId(child.executionId)
      if (seen.has(childId)) continue
      seen.add(childId)
      let parent = toolForChild(parentProjection(), child.executionId)
      if (parent === undefined) {
        const ensured = Transcript.ensureChildTool(parentProjection(), child.executionId, "task")
        settleParent(ensured.projection)
        parent = ensured.tool
        yield* Effect.logWarning("execution.child.parent_synthesized").pipe(
          Effect.annotateLogs({
            "rika.execution.parent": current.executionId,
            "rika.execution.child": child.executionId,
          }),
        )
      }
      const projection = yield* replayProjection(backend, child.executionId)
      const settled = settledChildStatus(child.status)
      if (settled !== undefined)
        settleParent(
          Transcript.settleChild(parentProjection(), child.executionId, settled, parentProjection().revision),
        )
      nested.push({ parentId: parent.id, projection })
      pending.push({ executionId: child.executionId, nestedIndex: nested.length - 1, reference: true })
    }
  }
  return nested.length === 0 ? rootProjection : Transcript.withNestedProjections(rootProjection, nested)
})

const activeDescendantExecutionIds = Effect.fn("Operation.activeDescendantExecutionIds")(function* (
  backend: ExecutionBackend.Interface,
  rootExecutionId: string,
) {
  const pending: Array<{ readonly executionId: string; readonly reference: boolean }> = [
    { executionId: rootExecutionId, reference: false },
  ]
  const seen = new Set([normalizeChildExecutionId(rootExecutionId)])
  const active: Array<string> = []
  while (pending.length > 0) {
    const current = pending.shift()!
    const inspection = yield* backend.inspect(
      current.executionId,
      current.reference ? ExecutionBackend.executionReference : undefined,
    )
    if (inspection === undefined) continue
    for (const child of inspection.children) {
      const normalized = normalizeChildExecutionId(child.executionId)
      if (seen.has(normalized)) continue
      seen.add(normalized)
      pending.push({ executionId: child.executionId, reference: true })
      if (!isTerminalStatus(child.status)) active.push(child.executionId)
    }
  }
  return active
})

const persistExecutionTree = Effect.fn("Operation.persistExecutionTree")(function* (turn: Turn.Turn, force: boolean) {
  const transcripts = yield* TranscriptRepository.Service
  const current = yield* transcripts.get(turn.id)
  if (current === undefined) return
  const root = sourceProjection(current)
  if (!force && !hasMissingNestedProjection(root)) return
  const backend = yield* ExecutionBackend.Service
  const tree = yield* projectExecutionTree(backend, turn.id, root)
  if (tree === root) return
  yield* transcripts.replace(turn, tree)
})

const childExecutionId = (event: ExecutionBackend.Event): string | undefined => {
  if (event.type !== "child_run.spawned") return undefined
  const member = event.data?.member
  const nested =
    member !== null && typeof member === "object" ? (member as Readonly<Record<string, unknown>>) : undefined
  const value = nested?.child_execution_id ?? event.data?.child_execution_id
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const childTranscriptPatch = (
  threadId: Thread.ThreadId,
  executionId: string,
  rootTurnId: Turn.TurnId,
  event: ExecutionBackend.Event,
): InteractiveEvent => ({
  _tag: "TranscriptPatched",
  selectionEpoch: 0,
  threadId,
  turnId: Turn.TurnId.make(normalizeChildExecutionId(executionId)),
  ...(event.type === "model.usage.reported" || event.type === "child_run.spawned" ? { rootTurnId } : {}),
  event,
  revision: event.sequence,
})

export const internal = {
  activeDescendantExecutionIds,
  childExecutionId,
  childTranscriptPatch,
  normalizeChildExecutionId,
  persistExecutionTree,
  rootCheckpointCursor,
  sourceProjection,
  transcriptPatch,
}
