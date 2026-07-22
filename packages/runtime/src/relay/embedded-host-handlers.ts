import { Agent, TurnPolicy } from "@batonfx/core"
import { Client, Content, Ids, WorkflowDefinitionHost } from "@relayfx/sdk"
import { Clock, Deferred, Effect, Layer, Schema } from "effect"
import { Toolkit } from "effect/unstable/ai"
import { presets } from "../agent-profiles"
import { addressId, childSessionId, internal as codec } from "./execution-codec"
import { internal as optionsInternal, toolkitFor, type LayerOptions } from "./options"
const { makeChildExecutionId } = codec
const { compactionPolicy } = optionsInternal

type HostOptions<AdditionalTools extends Record<string, import("effect/unstable/ai").Tool.Any>> = Pick<
  LayerOptions<AdditionalTools>,
  | "selection"
  | "oracleSelection"
  | "compaction"
  | "oracleCompaction"
  | "compactionSummarySelection"
  | "permissionPolicy"
>

const makeWorkflowHandlers = <
  AdditionalTools extends Record<string, import("effect/unstable/ai").Tool.Any>,
  RuntimeRequirements,
  Output extends Schema.Json,
  E,
>(
  options: HostOptions<AdditionalTools> & LayerOptions<AdditionalTools, RuntimeRequirements>,
  relayClient: Deferred.Deferred<Client.Interface>,
  toolOptionsForExecution: (execution: string) => Effect.Effect<LayerOptions<AdditionalTools, RuntimeRequirements>, E>,
  childResult: (
    client: Client.Interface,
    childId: string,
  ) => Effect.Effect<{ readonly output: Output }, Client.ClientError | Client.EventLogCursorNotFound>,
) =>
  Layer.succeed(
    WorkflowDefinitionHost.Service,
    WorkflowDefinitionHost.Service.of({
      child: (parentId, operation, context) => {
        const parentExecutionId = String(parentId)
        const childId = makeChildExecutionId(parentExecutionId, String(operation.id))
        const grounded = "address_id" in operation
        const profileName = grounded ? String(operation.preset_name) : "Task"
        const availablePresets = presets(options.selection, options.oracleSelection)
        const preset = availablePresets[profileName] ?? availablePresets.Task!
        const childSelection = {
          provider: preset.model.provider,
          model: preset.model.model,
          ...(preset.model.registration_key === undefined ? {} : { registrationKey: preset.model.registration_key }),
        }
        const childAgentId = Ids.AgentId.make(
          `agent:rika:workflow:${encodeURIComponent(parentExecutionId)}:${String(operation.id)}`,
        )
        const policy = compactionPolicy(
          profileName === "Oracle" ? (options.oracleCompaction ?? options.compaction) : options.compaction,
          options.compactionSummarySelection,
        )
        return Deferred.await(relayClient).pipe(
          Effect.flatMap((client) =>
            Effect.gen(function* () {
              const startedAt = yield* Clock.currentTimeMillis
              const executionToolOptions = yield* toolOptionsForExecution(parentExecutionId)
              const childToolkit = Toolkit.make(
                ...Object.values(toolkitFor(executionToolOptions).tools).filter((tool) =>
                  preset.tool_names.includes(tool.name),
                ),
              )
              const encodedInput = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(operation.input ?? {})
              const registered = yield* client.agents.register({
                id: childAgentId,
                address: grounded ? operation.address_id : addressId,
                agent: Agent.make({
                  name: `rika-workflow-${String(childId)}`,
                  instructions: preset.instructions,
                  model: childSelection,
                  toolkit: childToolkit,
                  policy: TurnPolicy.forever,
                }),
                permissions: preset.permissions.map((name) => ({ name, value: true })),
                ...(options.permissionPolicy === undefined ? {} : { permission_rules: options.permissionPolicy }),
                metadata: { ...preset.metadata, steering_enabled: true, rika_execution_id: String(childId) },
                ...(policy === undefined ? {} : { compaction_policy: policy }),
              })
              yield* client.executions
                .startByAgentDefinition({
                  root_address_id: grounded ? operation.address_id : addressId,
                  session_id: childSessionId(childId),
                  agent_id: childAgentId,
                  agent_revision: registered.record.current_revision,
                  execution_id: Ids.ExecutionId.make(String(childId)),
                  input: [Content.text(encodedInput)],
                  idempotency_key: context.idempotency_key,
                  started_at: startedAt,
                  completed_at: startedAt,
                  metadata: {
                    parent_execution_id: parentId,
                    child_execution_id: childId,
                    workflow_operation_id: operation.id,
                  },
                })
                .pipe(
                  Effect.catchTag("ClientError", (startError) =>
                    client.executions
                      .get(Ids.ExecutionId.make(String(childId)))
                      .pipe(
                        Effect.flatMap((existing) =>
                          existing === undefined ? Effect.fail(startError) : Effect.succeed(existing),
                        ),
                      ),
                  ),
                )
              return (yield* childResult(client, String(childId))).output
            }),
          ),
          Effect.mapError((cause) => WorkflowDefinitionHost.HandlerError.make({ message: String(cause) })),
        )
      },
      approval: (_parentId, operation) => Effect.succeed({ approved: true, prompt: operation.prompt }),
      timer: (_parentId, operation) => Effect.sleep(`${operation.duration_ms} millis`),
      branch: () => Effect.succeed(true),
      structuredCompletion: (_schema, value) => Effect.succeed(value ?? null),
    }),
  )

export const internal = { makeWorkflowHandlers }
