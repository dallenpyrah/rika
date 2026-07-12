import { Client } from "@relayfx/sdk"
import { Effect } from "effect"

export const missingSurfaceMessage = (member: string) =>
  `@relayfx/sdk 0.1.0 does not expose ${member}; the durable child fan-out and workflow surfaces return once the fix/sqlite-sdk-package relay work ships in a release`

const unavailable = (member: string) => () => Effect.fail(new Error(missingSurfaceMessage(member)))

export interface FanOutWorkflowSurface {
  readonly createChildFanOut: (input: {
    readonly fan_out_id: string
    readonly parent_execution_id: string
    readonly children: ReadonlyArray<Record<string, unknown>>
    readonly max_concurrency: number
    readonly join: { readonly _tag: string; readonly count?: number }
    readonly created_at: number
  }) => Effect.Effect<any, unknown>
  readonly inspectChildFanOut: (input: { readonly fan_out_id: string }) => Effect.Effect<any, unknown>
  readonly cancelChildFanOut: (input: {
    readonly fan_out_id: string
    readonly cancelled_at: number
    readonly reason?: string
  }) => Effect.Effect<any, unknown>
  readonly registerWorkflowDefinition: (payload: WorkflowDefinitionPayload) => Effect.Effect<any, unknown>
  readonly startWorkflowRun: (input: {
    readonly execution_id: string
    readonly workflow_definition_id: string
    readonly revision?: number
  }) => Effect.Effect<any, unknown>
  readonly inspectWorkflowRun: (executionId: string) => Effect.Effect<any, unknown>
  readonly cancelWorkflowRun: (executionId: string) => Effect.Effect<any, unknown>
}

export type ExtendedClient = Client.Interface & FanOutWorkflowSurface

export const extend = (client: Client.Interface): ExtendedClient => {
  const candidate = client as Client.Interface & Partial<FanOutWorkflowSurface>
  return {
    ...client,
    createChildFanOut: candidate.createChildFanOut ?? unavailable("createChildFanOut"),
    inspectChildFanOut: candidate.inspectChildFanOut ?? unavailable("inspectChildFanOut"),
    cancelChildFanOut: candidate.cancelChildFanOut ?? unavailable("cancelChildFanOut"),
    registerWorkflowDefinition: candidate.registerWorkflowDefinition ?? unavailable("registerWorkflowDefinition"),
    startWorkflowRun: candidate.startWorkflowRun ?? unavailable("startWorkflowRun"),
    inspectWorkflowRun: candidate.inspectWorkflowRun ?? unavailable("inspectWorkflowRun"),
    cancelWorkflowRun: candidate.cancelWorkflowRun ?? unavailable("cancelWorkflowRun"),
  }
}

export interface WorkflowOperationShape {
  readonly id: string
  readonly kind: string
  readonly [field: string]: unknown
}

export interface WorkflowDefinitionPayload {
  readonly id: string
  readonly definition: {
    readonly version: 2
    readonly name: string
    readonly entry_operation_id: string
    readonly operations: ReadonlyArray<WorkflowOperationShape>
    readonly metadata: Record<string, unknown>
  }
}

export interface LegacySqliteRuntimes {
  readonly ChildFanOutRuntime?: any
  readonly WorkflowDefinitionRuntime?: any
}

export interface LegacySqliteLayers {
  readonly childFanOutLayer?: any
  readonly workflowLayer?: any
}

export const legacyRuntimes = (sqliteModule: object): LegacySqliteRuntimes => sqliteModule as LegacySqliteRuntimes

export const legacyLayers = (sqliteNamespace: object): LegacySqliteLayers => sqliteNamespace as LegacySqliteLayers

export const hasFanOutWorkflowRuntimes = (sqliteModule: object, sqliteNamespace: object): boolean => {
  const runtimes = legacyRuntimes(sqliteModule)
  const layers = legacyLayers(sqliteNamespace)
  return (
    runtimes.ChildFanOutRuntime !== undefined &&
    runtimes.WorkflowDefinitionRuntime !== undefined &&
    layers.childFanOutLayer !== undefined &&
    layers.workflowLayer !== undefined
  )
}
