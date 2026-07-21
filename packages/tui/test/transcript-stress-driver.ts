import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import * as Transcript from "@rika/transcript"
import { Surface, maxMountedTranscriptRows } from "../src/adapter"
import { TranscriptPresenter, ViewState } from "../src"

export interface TranscriptRenderStressResult {
  readonly items: number
  readonly expandedRows: number
  readonly mountedAfterLoad: number
  readonly mountedAfterBurst: number
  readonly mountedLimit: number
  readonly updateP50Milliseconds: number
  readonly updateP95Milliseconds: number
  readonly updateWorstMilliseconds: number
  readonly renderP95Milliseconds: number
  readonly averageFrameTimeMilliseconds: number
}

const childTurnId = (child: number) => `child:turn:agent-${child}`

const sourceEvent = (
  cursor: string,
  sequence: number,
  type: string,
  fields: Partial<Transcript.SourceEvent> = {},
): Transcript.SourceEvent => ({ cursor, sequence, type, createdAt: sequence, ...fields })

const parentProjection = (childCount: number) =>
  Transcript.project("turn", "prompt", [
    sourceEvent("assistant-0", 0, "model.output.completed", { text: "Fanning out two hundred subagents." }),
    ...Array.from({ length: childCount }, (_, child) => [
      sourceEvent(`agent-${child}`, 1 + child * 2, "tool.call.requested", {
        data: { tool_call_id: `agent-${child}`, tool_name: "task", input: { prompt: `Task ${child}` } },
      }),
      sourceEvent(`agent-${child}-spawned`, 2 + child * 2, "child_run.spawned", {
        data: { tool_call_id: `agent-${child}`, child_execution_id: childTurnId(child) },
      }),
    ]).flat(),
  ])

const childProjection = (child: number, toolsPerChild: number) =>
  Transcript.project(childTurnId(child), "", [
    ...Array.from({ length: toolsPerChild }, (_, tool) => [
      sourceEvent(`tool-${child}-${tool}`, tool * 2, "tool.call.requested", {
        data: { tool_call_id: `tool-${child}-${tool}`, tool_name: "read", input: { path: `src/${child}/${tool}.ts` } },
      }),
      sourceEvent(`tool-${child}-${tool}-result`, tool * 2 + 1, "tool.result.received", {
        data: { tool_call_id: `tool-${child}-${tool}`, output: `contents ${child} ${tool}` },
      }),
    ]).flat(),
    sourceEvent(`answer-${child}`, toolsPerChild * 2, "model.output.completed", {
      text: `Child ${child} verified the target module.`,
    }),
  ])

const percentile = (samples: ReadonlyArray<number>, ratio: number): number => {
  const sorted = [...samples].toSorted((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
}

const transcriptRenderStress = Effect.fnUntraced(function* (options: {
  readonly childCount: number
  readonly toolsPerChild: number
  readonly streamedUpdates: number
}) {
  const setup = yield* Effect.promise(() => createTestRenderer({ width: 120, height: 40 }))
  let projections = new Map(
    Array.from(
      { length: options.childCount },
      (_, child) => [childTurnId(child), childProjection(child, options.toolsPerChild)] as const,
    ),
  )
  const base = TranscriptPresenter.applyTurnUnits(
    { ...ViewState.initial("/work", "high"), width: 120, height: 40 },
    parentProjection(options.childCount).units,
  )
  const attached = TranscriptPresenter.attachChildProjections(base, new Set<string>(), projections)
  let attachments = attached.attachments
  let model: ViewState.Model = {
    ...attached.model,
    expandedRowKeys: [...TranscriptPresenter.expandableRowIds(attached.model)],
  }
  const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
  return yield* Effect.gen(function* () {
    surface.update(model)
    yield* Effect.promise(() => setup.renderOnce())
    const state = surface as unknown as { readonly transcriptChildren: ReadonlyArray<unknown> }
    const mountedAfterLoad = state.transcriptChildren.length
    const updateLatencies: Array<number> = []
    const renderLatencies: Array<number> = []
    for (let step = 0; step < options.streamedUpdates; step += 1) {
      const child = step % options.childCount
      const turnId = childTurnId(child)
      const bumped = Transcript.applyEvent(
        projections.get(turnId)!,
        sourceEvent(`stream-${child}-${step}`, options.toolsPerChild * 2 + 1 + step, "model.output.delta", {
          text: ` delta ${step}`,
        }),
      )
      projections = new Map(projections)
      projections.set(turnId, bumped)
      const next = TranscriptPresenter.attachChildProjections(model, new Set<string>(), projections, attachments)
      attachments = next.attachments
      model = next.model as ViewState.Model
      const startedAt = performance.now()
      surface.update(model)
      updateLatencies.push(performance.now() - startedAt)
      if (step % 10 === 9) {
        const renderStartedAt = performance.now()
        yield* Effect.promise(() => setup.renderOnce())
        renderLatencies.push(performance.now() - renderStartedAt)
      }
    }
    yield* Effect.promise(() => setup.renderOnce())
    const stats = setup.renderer.getStats()
    return {
      items: model.items.length,
      expandedRows: model.expandedRowKeys.length,
      mountedAfterLoad,
      mountedAfterBurst: state.transcriptChildren.length,
      mountedLimit: maxMountedTranscriptRows * 2,
      updateP50Milliseconds: percentile(updateLatencies, 0.5),
      updateP95Milliseconds: percentile(updateLatencies, 0.95),
      updateWorstMilliseconds: Math.max(...updateLatencies),
      renderP95Milliseconds: percentile(renderLatencies, 0.95),
      averageFrameTimeMilliseconds: stats.averageFrameTime,
    }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        surface.destroy()
        setup.renderer.destroy()
      }),
    ),
  )
})

export const runTranscriptRenderStress = (options: {
  readonly childCount: number
  readonly toolsPerChild: number
  readonly streamedUpdates: number
}): Promise<TranscriptRenderStressResult> => Effect.runPromise(transcriptRenderStress(options))
