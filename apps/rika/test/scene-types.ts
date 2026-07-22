export type ModelPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "toolCall"; readonly name: string; readonly params: unknown; readonly id?: string }

export type ModelTurn =
  | {
      readonly parts: readonly [ModelPart, ...ReadonlyArray<ModelPart>]
      readonly delayMs?: number
      readonly usage?: ModelUsage
    }
  | { readonly object: unknown; readonly delayMs?: number; readonly usage?: ModelUsage }
  | { readonly failure: string; readonly delayMs?: number; readonly usage?: ModelUsage }

export interface ModelUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export type Action = {
  readonly after?: string
  readonly childStatus?: string
  readonly childCount?: number
  readonly write?: string
  readonly checkRunning?: boolean
  readonly delayMs?: number
  readonly restartArguments?: ReadonlyArray<string>
  readonly resize?: { readonly width: number; readonly height: number }
  readonly resizes?: ReadonlyArray<{ readonly width: number; readonly height: number }>
  readonly files?: Readonly<Record<string, string | null>>
  readonly queueCount?: number
  readonly queuePrompt?: string
  readonly queueRevision?: number
  readonly turnPrompt?: string
  readonly turnStatus?: string
  readonly timeoutMs?: number
  readonly visible?: boolean
}

export type SceneSymlink = {
  readonly path: string
  readonly target: string
  readonly outside?: boolean
}

export type SceneExecutable = {
  readonly name: string
  readonly exitCode?: number
  readonly waitForInput?: boolean
}

export interface Options {
  readonly actions: ReadonlyArray<Action>
  readonly files?: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array; readonly executable?: boolean }>
  readonly arguments?: ReadonlyArray<string>
  readonly script?: readonly [ModelTurn, ...ReadonlyArray<ModelTurn>]
  readonly response?: string
  readonly globalSettings?: unknown
  readonly workspaceSettings?: unknown
  readonly workspace?: Readonly<Record<string, string>>
  readonly git?: boolean
  readonly terminal?: {
    readonly columns: number
    readonly rows: number
  }
  readonly editorContent?: string
  readonly mediaAnalyzer?: { readonly response: string } | { readonly error: string }
  readonly toolApprovals?: ReadonlyArray<string>
  readonly inspectPaths?: ReadonlyArray<string>
  readonly outsideFiles?: Readonly<Record<string, string>>
  readonly symlinks?: ReadonlyArray<SceneSymlink>
  readonly environment?: Readonly<Record<string, string | null>>
  readonly executable?: SceneExecutable
}
