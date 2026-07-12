import type { Mode } from "./view-state"

export interface Command {
  readonly id: string
  readonly category: string
  readonly label: string
  readonly keybinding?: string
  readonly action: PaletteAction
}

export type PaletteAction =
  | { readonly _tag: "SubmitInput" }
  | { readonly _tag: "OpenModePicker" }
  | { readonly _tag: "SwitchThread" }
  | { readonly _tag: "Quit" }
  | { readonly _tag: "ShowContext" }
  | { readonly _tag: "Review" }
  | { readonly _tag: "SetMode"; readonly mode: Mode }
  | { readonly _tag: "ToggleChangedFiles" }
  | { readonly _tag: "ToggleFastMode" }
  | { readonly _tag: "SetReasoningEffort"; readonly effort: "low" | "medium" | "high" | "xhigh" }

export const commands: ReadonlyArray<Command> = [
  { id: "threads", category: "thread", label: "switch", keybinding: "Ctrl+T", action: { _tag: "SwitchThread" } },
  { id: "run", category: "thread", label: "run prompt", action: { _tag: "SubmitInput" } },
  { id: "mode", category: "mode", label: "change mode", keybinding: "Ctrl+S", action: { _tag: "OpenModePicker" } },
  { id: "mode-low", category: "mode", label: "low", action: { _tag: "SetMode", mode: "low" } },
  { id: "mode-medium", category: "mode", label: "medium", action: { _tag: "SetMode", mode: "medium" } },
  { id: "mode-high", category: "mode", label: "high", action: { _tag: "SetMode", mode: "high" } },
  { id: "mode-ultra", category: "mode", label: "ultra", action: { _tag: "SetMode", mode: "ultra" } },
  { id: "context", category: "context", label: "show context and cost", action: { _tag: "ShowContext" } },
  { id: "review", category: "review", label: "review workspace changes", action: { _tag: "Review" } },
  {
    id: "changed-files",
    category: "review",
    label: "changed files",
    keybinding: "Opt+S",
    action: { _tag: "ToggleChangedFiles" },
  },
  { id: "fast-mode", category: "rika", label: "toggle fast mode", action: { _tag: "ToggleFastMode" } },
  {
    id: "reasoning-low",
    category: "reasoning",
    label: "low",
    action: { _tag: "SetReasoningEffort", effort: "low" },
  },
  {
    id: "reasoning-medium",
    category: "reasoning",
    label: "medium",
    action: { _tag: "SetReasoningEffort", effort: "medium" },
  },
  {
    id: "reasoning-high",
    category: "reasoning",
    label: "high",
    keybinding: "Opt+D",
    action: { _tag: "SetReasoningEffort", effort: "high" },
  },
  {
    id: "reasoning-xhigh",
    category: "reasoning",
    label: "xhigh",
    action: { _tag: "SetReasoningEffort", effort: "xhigh" },
  },
  { id: "quit", category: "rika", label: "quit", keybinding: "Ctrl+C Ctrl+C", action: { _tag: "Quit" } },
]

export const filter = (query: string): ReadonlyArray<Command> => {
  const needle = query.trim().toLowerCase().replace(/^\//, "")
  return needle.length === 0
    ? commands
    : commands.filter((command) => `${command.category} ${command.label}`.toLowerCase().includes(needle))
}
