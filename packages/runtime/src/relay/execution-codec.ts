import { ModelRegistry } from "@batonfx/core"
import { Client, Content, type Execution, Ids } from "@relayfx/sdk"
import { Effect, Schema } from "effect"
import {
  type AgentProfile,
  BackendError,
  Event,
  type ExecutionReference,
  type ExecutionRoutePin,
  type PromptPart,
  Status,
} from "../execution-contract"
import { childExecutionId as encodeChildExecutionId } from "../agent-depth"
export const agentId = Ids.AgentId.make("agent:rika")
export const addressId = Ids.AddressId.make("address:rika")
const fanOutAgentId = (fanOutId: unknown, childExecutionId: unknown) =>
  Ids.AgentId.make(`agent:rika:fan-out:${String(fanOutId)}:${String(childExecutionId)}`)
const executionId = (turnId: string, reference?: ExecutionReference) =>
  Ids.ExecutionId.make(reference === undefined ? `execution:${turnId}` : turnId)
const awaitExecutionAvailable = (
  client: Client.Interface,
  id: Ids.ExecutionId,
  timeoutMessage: string,
): Effect.Effect<void, Client.ClientError> => {
  const poll: Effect.Effect<void, Client.ClientError> = Effect.suspend(() =>
    client.executions
      .get(id)
      .pipe(
        Effect.flatMap((existing) =>
          existing === undefined ? Effect.sleep("25 millis").pipe(Effect.andThen(poll)) : Effect.void,
        ),
      ),
  )
  return poll.pipe(
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () => Effect.fail(Client.ClientError.make({ message: timeoutMessage })),
    }),
  )
}
const makeChildExecutionId = (parentTurnId: string, childId: string) =>
  Ids.ChildExecutionId.make(encodeChildExecutionId(parentTurnId, childId))
export const modelSelection = (model: {
  readonly provider: string
  readonly model: string
  readonly registration_key?: string
}): ModelRegistry.ModelSelection => ({
  provider: model.provider,
  model: model.model,
  ...(model.registration_key === undefined ? {} : { registrationKey: model.registration_key }),
})
export const executionRouteFromMetadata = (metadata: Readonly<Record<string, unknown>> | undefined) => {
  const route = metadata?.rika_execution_route
  if (route === null || typeof route !== "object" || !("main" in route) || !("oracle" in route)) return undefined
  return route as unknown as ExecutionRoutePin
}
const pinnedRouteForExecution = (client: Client.Interface, execution: Execution.Execution) =>
  Effect.gen(function* () {
    let current: Execution.Execution | undefined = execution
    for (let depth = 0; depth < 3 && current !== undefined; depth += 1) {
      const route =
        executionRouteFromMetadata(current.metadata) ??
        executionRouteFromMetadata(current.agent_snapshot?.metadata) ??
        executionRouteFromMetadata(current.agent_snapshot?.model.metadata)
      if (route !== undefined) return route
      const parentId: unknown = current.metadata?.parent_execution_id
      current = typeof parentId === "string" ? yield* client.executions.get(Ids.ExecutionId.make(parentId)) : undefined
    }
    return undefined
  })
const routeForProfile = (pin: ExecutionRoutePin, profile: AgentProfile) => {
  if (profile === "Oracle") return pin.oracle
  if (pin.agents === undefined) return pin.main
  if (profile === "Librarian") return pin.agents.librarian
  if (profile === "Painter") return pin.agents.painter
  if (profile === "Review") return pin.agents.review
  if (profile === "ReadThread") return pin.agents.readThread
  return pin.agents.task
}
export const executionRoutes = (pin: ExecutionRoutePin) => [
  pin.main,
  pin.oracle,
  ...(pin.title === undefined ? [] : [pin.title]),
  ...(pin.compactionSummary === undefined ? [] : [pin.compactionSummary]),
  ...(pin.agents === undefined
    ? []
    : [pin.agents.librarian, pin.agents.painter, pin.agents.review, pin.agents.readThread, pin.agents.task]),
]
const routeForSelection = (pin: ExecutionRoutePin, selection: ModelRegistry.ModelSelection) =>
  executionRoutes(pin).find(
    (route) =>
      route.provider === selection.provider &&
      route.model === selection.model &&
      route.registrationKey === selection.registrationKey,
  )
export const recoveredDeltaOutput = (events: ReadonlyArray<Execution.ExecutionEvent>) => {
  const groups = new Map<string, { order: number; deltas: Array<{ index: number; delta: string }> }>()
  for (const event of events) {
    if (event.type !== "model.output.delta") continue
    const delta = event.data?.delta
    if (typeof delta !== "string" || delta.length === 0) continue
    const partId = typeof event.data?.part_id === "string" ? event.data.part_id : ""
    const group = groups.get(partId) ?? { order: groups.size, deltas: [] }
    const index = typeof event.data?.delta_index === "number" ? event.data.delta_index : group.deltas.length
    group.deltas.push({ index, delta })
    groups.set(partId, group)
  }
  const text = [...groups.values()]
    .toSorted((left, right) => left.order - right.order)
    .map((group) =>
      group.deltas
        .toSorted((left, right) => left.index - right.index)
        .map((entry) => entry.delta)
        .join(""),
    )
    .join("\n\n")
  return text.length === 0 ? [] : [{ type: "text", text }]
}

export const childFailureText = (terminal: Execution.ExecutionEvent | undefined) => {
  if (terminal?.type !== "execution.failed" && terminal?.type !== "execution.cancelled") return undefined
  const message = terminal.data?.message
  const outcome =
    terminal.type === "execution.cancelled" ? "Subagent execution was cancelled" : "Subagent execution failed"
  return typeof message === "string" && message.length > 0 ? `${outcome}: ${message}` : outcome
}

export const resolveChildResult = (events: ReadonlyArray<Execution.ExecutionEvent>) => {
  const terminal = events.findLast(
    (executionEvent) =>
      executionEvent.type === "execution.completed" ||
      executionEvent.type === "execution.failed" ||
      executionEvent.type === "execution.cancelled",
  )
  const lastToolSequence =
    events.findLast(
      (executionEvent) =>
        executionEvent.type === "tool.call.requested" || executionEvent.type === "tool.result.received",
    )?.sequence ?? -1
  const finalResponse = events.findLast(
    (executionEvent) =>
      executionEvent.type === "model.output.completed" &&
      executionEvent.sequence > lastToolSequence &&
      executionEvent.content?.some((part) => part.type === "text" && part.text.trim().length > 0) === true,
  )
  const recovered = terminal?.type === "execution.failed" && finalResponse !== undefined
  const terminalContent =
    terminal?.content === undefined || terminal.content.length === 0 ? undefined : terminal.content
  const primary =
    recovered || terminalContent === undefined
      ? (finalResponse?.content ?? recoveredDeltaOutput(events))
      : terminalContent
  const failure =
    recovered || terminalContent !== undefined || finalResponse !== undefined ? undefined : childFailureText(terminal)
  return {
    status:
      terminal?.type === "execution.completed" || recovered
        ? ("completed" as const)
        : terminal?.type === "execution.cancelled"
          ? ("cancelled" as const)
          : ("failed" as const),
    output: failure === undefined ? primary : [...primary, { type: "text", text: failure }],
  }
}
const awaitChildResult = (client: Client.Interface, childId: string) => {
  const childExecutionId = Ids.ExecutionId.make(childId)
  const poll: Effect.Effect<ReturnType<typeof resolveChildResult>, Client.ClientError> = Effect.suspend(() =>
    client.executions.inspect(childExecutionId).pipe(
      Effect.flatMap((inspection) =>
        inspection.status === "completed" || inspection.status === "failed" || inspection.status === "cancelled"
          ? client.executions
              .replay({ execution_id: childExecutionId })
              .pipe(Effect.map((replay) => resolveChildResult(replay.events)))
          : Effect.sleep("20 millis").pipe(Effect.andThen(poll)),
      ),
      Effect.catchTag("ExecutionNotFound", () => Effect.sleep("20 millis").pipe(Effect.andThen(poll))),
    ),
  )
  return poll
}
const workflowExecutionId = (runId: string, ownerTurnId?: string, workspace?: string) =>
  Ids.ExecutionId.make(
    ownerTurnId === undefined
      ? workspace === undefined
        ? `workflow:${runId}`
        : `workflow:workspace:${encodeURIComponent(workspace)}:run:${encodeURIComponent(runId)}`
      : `workflow:turn:${encodeURIComponent(ownerTurnId)}:run:${encodeURIComponent(runId)}`,
  )
export const attachedWorkflow = (value: string) => {
  const match = /^workflow:turn:([^:]+):run:(.+)$/.exec(value)
  if (match === null) return undefined
  try {
    return { ownerTurnId: decodeURIComponent(match[1]!), runId: decodeURIComponent(match[2]!) }
  } catch {
    return undefined
  }
}
export const childParentExecutionId = (value: string) => {
  if (!value.startsWith("child:")) return undefined
  const separator = value.indexOf(":", "child:".length)
  if (separator < 0) return undefined
  try {
    return decodeURIComponent(value.slice("child:".length, separator))
  } catch {
    return undefined
  }
}
export const standaloneWorkflow = (value: string) => {
  const match = /^workflow:workspace:([^:]+):run:(.+)$/.exec(value)
  if (match === null) return undefined
  try {
    return { workspace: decodeURIComponent(match[1]!), runId: decodeURIComponent(match[2]!) }
  } catch {
    return undefined
  }
}
const childIdFromExecutionId = (parentTurnId: string, value: unknown) => {
  const id = String(value)
  const prefix = `child:${encodeURIComponent(parentTurnId)}:`
  return id.startsWith(prefix) ? id.slice(prefix.length) : id.replace(/^child:/, "")
}
export const turnIdFromExecutionId = (value: string): string | undefined => {
  if (value.startsWith("execution:")) {
    const id = value.slice("execution:".length)
    const separator = id.indexOf(":child:")
    return separator < 0 ? id : id.slice(0, separator)
  }
  const workflowOwner = attachedWorkflow(value)?.ownerTurnId
  if (workflowOwner !== undefined) return workflowOwner
  const parent = childParentExecutionId(value)
  if (parent === undefined) return undefined
  if (parent.startsWith("workflow:") || parent.startsWith("execution:") || parent.startsWith("child:"))
    return turnIdFromExecutionId(parent)
  return parent
}
export const workspaceFromExecutionId = (value: string): string | undefined => {
  const workflow = standaloneWorkflow(value)
  if (workflow !== undefined) return workflow.workspace
  const parent = childParentExecutionId(value)
  return parent === undefined ? undefined : workspaceFromExecutionId(parent)
}
export const sessionId = (threadId: string) => Ids.SessionId.make(`session:${threadId}`)
export const childSessionId = (childExecutionId: Ids.ChildExecutionId) =>
  Ids.SessionId.make(`session:child:${String(childExecutionId)}`)
export const isBackendError = Schema.is(BackendError)
export const error = (cause: unknown): BackendError =>
  isBackendError(cause) ? cause : BackendError.make({ message: String(cause) })
export const executionInput = (input: { readonly prompt: string; readonly promptParts?: ReadonlyArray<PromptPart> }) =>
  input.promptParts?.map((part) =>
    part.type === "text"
      ? Content.text(part.text)
      : {
          type: "blob-reference" as const,
          uri: `data:${part.mediaType};base64,${part.data}`,
          media_type: part.mediaType,
          ...(part.filename === undefined ? {} : { filename: part.filename }),
        },
  ) ?? [Content.text(input.prompt)]

export const mapFanOut = (value: any) => {
  const parentTurnId = String(value.parent_execution_id).replace(/^execution:/, "")
  return {
    fanOutId: String(value.fan_out_id),
    parentTurnId,
    state: value.state,
    maxConcurrency: value.max_concurrency,
    join: value.join._tag,
    members: value.members.map((member: any) => ({
      childId: childIdFromExecutionId(parentTurnId, member.child_execution_id),
      ordinal: member.ordinal,
      state: member.state,
      ...(member.output === undefined
        ? {}
        : {
            output: Array.isArray(member.output)
              ? member.output.map((part: any) => (part.type === "text" ? part.text : JSON.stringify(part))).join("")
              : member.output,
          }),
      ...(member.error === undefined ? {} : { error: member.error }),
    })),
  }
}

export const workflow = (value: any) => {
  const execution = String(value.execution_id)
  const attached = attachedWorkflow(execution)
  const standalone = standaloneWorkflow(execution)
  return {
    runId: attached?.runId ?? standalone?.runId ?? execution.replace(/^workflow:/, ""),
    ...(attached === undefined ? {} : { ownerTurnId: attached.ownerTurnId }),
    workflow: String(value.pin.workflow_definition_id)
      .replace(/^rika:/, "")
      .replace(/:v1$/, ""),
    revision: value.pin.workflow_definition_revision,
    digest: value.pin.workflow_definition_digest,
    status: value.status,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  }
}

export const event = (value: {
  readonly cursor: string
  readonly sequence: number
  readonly type: string
  readonly created_at: number
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly data?: Readonly<Record<string, unknown>>
}): Event => {
  const contentText = value.content
    ?.filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
  const failureText =
    value.type === "execution.failed" && typeof value.data?.message === "string" && value.data.message.length > 0
      ? value.data.message
      : undefined
  const text = contentText !== undefined && contentText.length > 0 ? contentText : failureText
  return {
    cursor: value.cursor,
    sequence: value.sequence,
    type: value.type,
    createdAt: value.created_at,
    ...(text === undefined ? {} : { text }),
    ...(value.content === undefined ? {} : { content: [...value.content] }),
    ...(value.data === undefined ? {} : { data: value.data }),
  }
}

export const statusFromEvents = (events: ReadonlyArray<Event>): Status => {
  const type = events.findLast(
    (item) =>
      item.type === "execution.completed" || item.type === "execution.failed" || item.type === "execution.cancelled",
  )?.type
  if (type === "execution.completed") return "completed"
  if (type === "execution.failed") return "failed"
  if (type === "execution.cancelled") return "cancelled"
  if (events.findLast((item) => item.type === "wait.created") !== undefined) return "waiting"
  return "running"
}

export const isActionableWait = (item: Event) =>
  item.type === "permission.ask.requested" || item.type === "tool.approval.requested"

const executionTreeIds = (client: Client.Interface, root: Ids.ExecutionId) =>
  Effect.gen(function* () {
    const pending = [root]
    const seen = new Set<string>()
    const ids: Array<Ids.ExecutionId> = []
    while (pending.length > 0) {
      const current = pending.shift()!
      if (seen.has(String(current))) continue
      seen.add(String(current))
      ids.push(current)
      const inspection = yield* client.executions.inspect(current)
      for (const child of inspection.child_runs) {
        pending.push(Ids.ExecutionId.make(String(child.child_execution_id)))
      }
    }
    return ids
  })

const traceWithoutResult = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    let result!: A
    return effect.pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          result = value
        }),
      ),
      Effect.asVoid,
      Effect.withSpan(name),
      Effect.andThen(Effect.sync(() => result)),
    )
  })

export const internal = {
  fanOutAgentId,
  executionId,
  awaitExecutionAvailable,
  makeChildExecutionId,
  pinnedRouteForExecution,
  routeForProfile,
  routeForSelection,
  awaitChildResult,
  workflowExecutionId,
  executionTreeIds,
  traceWithoutResult,
}
