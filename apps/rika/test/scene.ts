import { run, runWarm } from "./scene-runtime"
import type { Action, ModelPart, ModelTurn, ModelUsage } from "./scene-types"

const withOptions = <A extends object>(
  value: A,
  delayMs?: number,
  usage?: ModelUsage,
): A & { readonly delayMs?: number; readonly usage?: ModelUsage } => ({
  ...value,
  ...(delayMs === undefined ? {} : { delayMs }),
  ...(usage === undefined ? {} : { usage }),
})

const escape = String.fromCharCode(27)
const mouseClick = (column: number, row: number): string =>
  `${escape}[<0;${column};${row}M${escape}[<0;${column};${row}m`

export const Scene = {
  run,
  runWarm,
  action: {
    writeAfter: (after: string, write: string, delayMs?: number): Action => ({
      after,
      write,
      ...(delayMs === undefined ? {} : { delayMs }),
    }),
    writeAfterVisible: (after: string, write: string, delayMs?: number): Action => ({
      after,
      write,
      visible: true,
      ...(delayMs === undefined ? {} : { delayMs }),
    }),
    writeWhenQueued: (queueCount: number, write: string, delayMs?: number): Action => ({
      write,
      queueCount,
      ...(delayMs === undefined ? {} : { delayMs }),
    }),
    writeWhenQueueRevision: (queuePrompt: string, queueRevision: number, write: string): Action => ({
      write,
      queuePrompt,
      queueRevision,
    }),
    writeWhenTurnStatus: (turnPrompt: string, turnStatus: string, write: string, delayMs?: number): Action => ({
      turnPrompt,
      turnStatus,
      write,
      ...(delayMs === undefined ? {} : { delayMs }),
    }),
    writeAfterVisibleWhenQueued: (after: string, queueCount: number, write: string): Action => ({
      after,
      write,
      queueCount,
      visible: true,
    }),
    writeAfterChildExecutions: (childStatus: string, childCount: number, write: string, delayMs?: number): Action => ({
      childStatus,
      childCount,
      write,
      ...(delayMs === undefined ? {} : { delayMs }),
    }),
    checkRunningAfter: (after: string, write: string): Action => ({ after, write, checkRunning: true }),
    restartAfter: (after: string, ...restartArguments: ReadonlyArray<string>): Action => ({
      after,
      write: "",
      restartArguments,
    }),
    restartWhenTurn: (turnPrompt: string, turnStatus: string, ...restartArguments: ReadonlyArray<string>): Action => ({
      turnPrompt,
      turnStatus,
      restartArguments,
    }),
    reconnectAfter: (after: string, write = ""): Action => ({
      after,
      write,
      restartArguments: ["threads", "continue", "--last"],
    }),
    writeAfterDelay: (write: string, delayMs: number): Action => ({ write, delayMs }),
    resizeAfter: (after: string, width: number, height: number, write?: string): Action => ({
      after,
      resize: { width, height },
      ...(write === undefined ? {} : { write }),
    }),
    resizeAfterDelay: (width: number, height: number, delayMs: number, write?: string): Action => ({
      resize: { width, height },
      delayMs,
      ...(write === undefined ? {} : { write }),
    }),
    filesAfter: (after: string, files: Readonly<Record<string, string | null>>, write?: string): Action => ({
      after,
      files,
      ...(write === undefined ? {} : { write }),
    }),
    clickAfter: (after: string, column: number, row: number): Action => ({
      after,
      write: mouseClick(column, row),
    }),
    clickRowsAfter: (after: string, column: number, rows: ReadonlyArray<number>): Action => ({
      after,
      write: rows.map((row) => mouseClick(column, row)).join(""),
    }),
    clickGridAfter: (after: string, columns: ReadonlyArray<number>, rows: ReadonlyArray<number>): Action => ({
      after,
      write: rows.flatMap((row) => columns.map((column) => mouseClick(column, row))).join(""),
    }),
    resizeBurstAfter: (
      after: string,
      resizes: ReadonlyArray<{ readonly width: number; readonly height: number }>,
      write = "",
      delayMs = 150,
    ): Action => ({ after, write, resizes, delayMs, checkRunning: true }),
  },
  model: {
    text: (text: string, delayMs?: number, usage?: ModelUsage): ModelTurn =>
      withOptions({ parts: [{ type: "text" as const, text }] as const }, delayMs, usage),
    object: (object: unknown, delayMs?: number, usage?: ModelUsage): ModelTurn =>
      withOptions({ object }, delayMs, usage),
    failure: (message: string, delayMs?: number, usage?: ModelUsage): ModelTurn =>
      withOptions({ failure: message }, delayMs, usage),
    turn: (parts: ReadonlyArray<ModelPart>, delayMs?: number, usage?: ModelUsage): ModelTurn => {
      if (parts.length === 0) throw new Error("A deterministic model turn needs at least one part")
      return withOptions({ parts: parts as [ModelPart, ...Array<ModelPart>] }, delayMs, usage)
    },
    textPart: (text: string): ModelPart => ({ type: "text", text }),
    reasoning: (text: string): ModelPart => ({ type: "reasoning", text }),
    toolCall: (name: string, params: unknown, id?: string): ModelPart => ({
      type: "toolCall",
      name,
      params,
      ...(id === undefined ? {} : { id }),
    }),
  },
} as const
