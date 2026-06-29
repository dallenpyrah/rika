import { Config } from "@rika/core"
import { Common, Event, Ids, Message } from "@rika/schema"

export type Activity = "idle" | "thinking" | "streaming" | "running-tools" | "failed"
export type CardKind = "context" | "tool" | "diff" | "error" | "skill" | "subagent" | "system"
export type CardStatus = "info" | "running" | "success" | "error"

export interface ThreadMessage {
  readonly id: string
  readonly role: Message.Role
  readonly text: string
}

export interface Card {
  readonly id: string
  readonly kind: CardKind
  readonly title: string
  readonly subtitle: string
  readonly status: CardStatus
  readonly collapsed: boolean
  readonly body?: string
}

export type TranscriptEntry =
  | { readonly kind: "message"; readonly message: ThreadMessage }
  | { readonly kind: "card"; readonly card: Card }

export interface Input {
  readonly thread_id: Ids.ThreadId
  readonly workspace_path: string
  readonly mode: Config.Mode
  readonly events?: ReadonlyArray<Event.Event>
}

export interface InputBuffer {
  readonly text: string
  readonly cursor: number
}

export interface ThinkingState {
  readonly text: string
  readonly visible: boolean
}

export interface PaletteState {
  readonly open: boolean
  readonly query: string
  readonly selected: number
}

export interface PickerItem {
  readonly label: string
  readonly insert: string
}

export interface FilePickerState {
  readonly open: boolean
  readonly query: string
  readonly selected: number
  readonly kind: "file" | "thread"
  readonly items: ReadonlyArray<PickerItem>
}

export interface ViewState {
  readonly thread_id: Ids.ThreadId
  readonly workspace_path: string
  readonly git_branch?: string
  readonly mode: Config.Mode
  readonly cost_usd: number
  readonly reasoning_effort: number
  readonly fast_mode: boolean
  readonly activity: Activity
  readonly active: boolean
  readonly spinner_index: number
  readonly messages: ReadonlyArray<ThreadMessage>
  readonly cards: ReadonlyArray<Card>
  readonly entries: ReadonlyArray<TranscriptEntry>
  readonly streaming_text: string
  readonly notice?: string
  readonly palette_open: boolean
  readonly input: InputBuffer
  readonly focus_index?: number
  readonly expanded_ids: ReadonlySet<string>
  readonly details_expanded: boolean
  readonly queued: ReadonlyArray<string>
  readonly queue_selected: number
  readonly history: ReadonlyArray<string>
  readonly history_index: number
  readonly nav_index: number
  readonly thinking: ThinkingState
  readonly palette: PaletteState
  readonly filepicker: FilePickerState
  readonly shortcuts_open: boolean
}

export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

const emptyInput: InputBuffer = { text: "", cursor: 0 }
const closedPalette: PaletteState = { open: false, query: "", selected: 0 }
const closedFilePicker: FilePickerState = { open: false, query: "", selected: 0, kind: "file", items: [] }
const hiddenThinking: ThinkingState = { text: "", visible: false }

const interactionDefaults = {
  input: emptyInput,
  expanded_ids: new Set<string>() as ReadonlySet<string>,
  details_expanded: false,
  queued: [] as ReadonlyArray<string>,
  queue_selected: -1,
  history: [] as ReadonlyArray<string>,
  history_index: -1,
  nav_index: -1,
  thinking: hiddenThinking,
  palette: closedPalette,
  filepicker: closedFilePicker,
  palette_open: false,
  shortcuts_open: false,
}

export const initial = (input: Input): ViewState =>
  fromEvents({ ...input, events: input.events ?? [] }, initialSeed(input))

export const fromEvents = (input: Input, seed = initialSeed(input)): ViewState =>
  (input.events ?? []).reduce((state, event) => applyEvent(state, event), seed)

const modeDefaultEffort = (mode: Config.Mode): number => (mode === "deep" ? 3 : mode === "smart" ? 2 : 1)

const initialSeed = (input: Input): ViewState => ({
  thread_id: input.thread_id,
  workspace_path: input.workspace_path,
  mode: input.mode,
  cost_usd: 0,
  reasoning_effort: modeDefaultEffort(input.mode),
  fast_mode: false,
  activity: "idle",
  active: false,
  spinner_index: 0,
  messages: [],
  cards: [],
  entries: [],
  streaming_text: "",
  ...interactionDefaults,
})

export const applyEvent = (state: ViewState, event: Event.Event): ViewState => {
  switch (event.type) {
    case "thread.created":
      return withoutNotice({ ...state, thread_id: event.thread_id })
    case "turn.started":
      return tick(withoutNotice({ ...state, activity: "thinking", active: true, streaming_text: "" }))
    case "message.added":
      return applyMessage(state, event)
    case "context.resolved":
      return tick({ ...state, activity: "thinking", active: true })
    case "skill.loaded":
      return tick(pushCard({ ...state, activity: "thinking", active: true }, skillCard(event)))
    case "subagent.completed":
      return tick(pushCard({ ...state, activity: "streaming", active: true }, subagentCard(event)))
    case "model.stream.chunk":
      return tick({
        ...state,
        activity: "streaming",
        active: true,
        streaming_text: `${state.streaming_text}${event.data.text}`,
      })
    case "model.reasoning.delta":
      return tick(withReasoningDelta(state, event.data.text))
    case "tool.call.requested":
      return tick(updateCard({ ...state, activity: "running-tools", active: true, streaming_text: "" }, toolCard(event)))
    case "tool.call.completed":
      return tick(applyToolResult({ ...state, activity: "streaming", active: true }, event))
    case "artifact.created":
      return pushCard(state, systemCard("Artifact created", event.data.artifact.kind, event.id))
    case "turn.completed":
      return { ...state, activity: "idle", active: false, streaming_text: "" }
    case "turn.failed":
      return pushCard({ ...state, activity: "failed", active: false, streaming_text: "" }, errorCard(event))
    case "thread.archived":
      return pushCard({ ...state, active: false, activity: "idle" }, systemCard("Thread archived", "", event.id))
  }
  return state
}

export const withMode = (state: ViewState, mode: Config.Mode): ViewState => ({
  ...state,
  mode,
  reasoning_effort: modeDefaultEffort(mode),
})

export const cycleReasoning = (state: ViewState): ViewState => ({
  ...state,
  reasoning_effort: (state.reasoning_effort % 3) + 1,
})

export const toggleFastMode = (state: ViewState): ViewState => ({ ...state, fast_mode: !state.fast_mode })

export const withGitBranch = (state: ViewState, branch: string | undefined): ViewState => ({
  ...state,
  ...(branch === undefined ? {} : { git_branch: branch }),
})

export const hasActivity = (state: ViewState): boolean => state.entries.length > 0

export const withThread = (
  state: ViewState,
  input: { readonly thread_id: Ids.ThreadId; readonly events: ReadonlyArray<Event.Event>; readonly notice?: string },
): ViewState => {
  const base = initialSeed({ thread_id: input.thread_id, workspace_path: state.workspace_path, mode: state.mode })
  const next = fromEvents(
    { thread_id: input.thread_id, workspace_path: state.workspace_path, mode: state.mode, events: input.events },
    base,
  )
  return input.notice === undefined ? next : withNotice(next, input.notice)
}

export const withNotice = (state: ViewState, notice: string): ViewState => ({
  ...state,
  notice,
  palette_open: false,
  palette: closedPalette,
  shortcuts_open: false,
})

export const withPalette = (state: ViewState): ViewState => ({
  ...state,
  palette_open: true,
  palette: { open: true, query: "", selected: 0 },
  shortcuts_open: false,
  notice:
    "Command palette: /mode, /skills, /skill, /threads, /search, /new, /thread, /archive, /unarchive, /share, /reference, /review, /exit",
})

const withoutNotice = (state: ViewState): ViewState => {
  const { notice: _notice, ...rest } = state
  return rest
}

export const insertText = (state: ViewState, text: string): ViewState => {
  const { text: current, cursor } = state.input
  const next = `${current.slice(0, cursor)}${text}${current.slice(cursor)}`
  return { ...state, input: { text: next, cursor: cursor + text.length }, history_index: -1, nav_index: -1 }
}

export const backspace = (state: ViewState): ViewState => {
  const { text, cursor } = state.input
  if (cursor === 0) return state
  const next = `${text.slice(0, cursor - 1)}${text.slice(cursor)}`
  return { ...state, input: { text: next, cursor: cursor - 1 } }
}

export const moveCursorLeft = (state: ViewState): ViewState => ({
  ...state,
  input: { ...state.input, cursor: Math.max(0, state.input.cursor - 1) },
})

export const moveCursorRight = (state: ViewState): ViewState => ({
  ...state,
  input: { ...state.input, cursor: Math.min(state.input.text.length, state.input.cursor + 1) },
})

export const moveCursorHome = (state: ViewState): ViewState => ({ ...state, input: { ...state.input, cursor: 0 } })

export const moveCursorEnd = (state: ViewState): ViewState => ({
  ...state,
  input: { ...state.input, cursor: state.input.text.length },
})

export const newline = (state: ViewState): ViewState => insertText(state, "\n")

export const clearInput = (state: ViewState): ViewState =>
  setFocus({ ...state, input: emptyInput, history_index: -1, nav_index: -1 }, undefined)

export const pushHistory = (state: ViewState, text: string): ViewState => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ...state, history_index: -1 }
  const history = state.history[state.history.length - 1] === trimmed ? state.history : [...state.history, trimmed]
  return { ...state, history, history_index: -1 }
}

export const historyPrev = (state: ViewState): ViewState => {
  if (state.history.length === 0) return state
  const index = state.history_index === -1 ? state.history.length - 1 : Math.max(0, state.history_index - 1)
  const text = state.history[index] ?? ""
  return { ...state, history_index: index, input: { text, cursor: text.length } }
}

export const historyNext = (state: ViewState): ViewState => {
  if (state.history_index === -1) return state
  const index = state.history_index + 1
  if (index >= state.history.length) return { ...state, history_index: -1, input: emptyInput }
  const text = state.history[index] ?? ""
  return { ...state, history_index: index, input: { text, cursor: text.length } }
}

export const userMessageTexts = (state: ViewState): ReadonlyArray<string> =>
  state.entries.flatMap((entry) => (entry.kind === "message" && entry.message.role === "user" ? [entry.message.text] : []))

export const navPrevMessage = (state: ViewState): ViewState => {
  const count = userMessageTexts(state).length
  if (count === 0) return state
  const next = state.nav_index === -1 ? 0 : Math.min(state.nav_index + 1, count - 1)
  return { ...state, nav_index: next }
}

export const navNextMessage = (state: ViewState): ViewState =>
  state.nav_index <= 0 ? { ...state, nav_index: -1 } : { ...state, nav_index: state.nav_index - 1 }

export const selectedNavId = (state: ViewState): string | undefined => {
  if (state.nav_index < 0) return undefined
  const userEntries = state.entries.filter((entry) => entry.kind === "message" && entry.message.role === "user")
  const entry = userEntries[userEntries.length - 1 - state.nav_index]
  return entry !== undefined && entry.kind === "message" ? entry.message.id : undefined
}

export const editNavMessage = (state: ViewState): ViewState => {
  const texts = userMessageTexts(state)
  if (state.nav_index < 0 || state.nav_index >= texts.length) return state
  const text = texts[texts.length - 1 - state.nav_index] ?? ""
  return { ...state, nav_index: -1, input: { text, cursor: text.length } }
}

export const clearNav = (state: ViewState): ViewState => (state.nav_index === -1 ? state : { ...state, nav_index: -1 })

const focusableCount = (state: ViewState) => state.cards.length

const setFocus = (state: ViewState, index: number | undefined): ViewState => {
  const { focus_index: _drop, ...rest } = state
  return index === undefined ? rest : { ...rest, focus_index: index }
}

export const focusPrev = (state: ViewState): ViewState => {
  const count = focusableCount(state)
  if (count === 0) return setFocus(state, undefined)
  if (state.focus_index === undefined) return setFocus(state, count - 1)
  return setFocus(state, Math.max(0, state.focus_index - 1))
}

export const focusNext = (state: ViewState): ViewState => {
  const count = focusableCount(state)
  if (count === 0) return setFocus(state, undefined)
  if (state.focus_index === undefined) return setFocus(state, 0)
  if (state.focus_index >= count - 1) return setFocus(state, undefined)
  return setFocus(state, state.focus_index + 1)
}

export const focusedCard = (state: ViewState): Card | undefined =>
  state.focus_index === undefined ? undefined : state.cards[state.focus_index]

export const toggleDetails = (state: ViewState): ViewState => {
  const card = focusedCard(state)
  if (card !== undefined) {
    const next = new Set(state.expanded_ids)
    if (next.has(card.id)) next.delete(card.id)
    else next.add(card.id)
    return { ...state, expanded_ids: next }
  }
  return { ...state, details_expanded: !state.details_expanded, thinking: { ...state.thinking, visible: !state.thinking.visible } }
}

export const isCardCollapsed = (state: ViewState, card: Card): boolean => {
  if (state.expanded_ids.has(card.id)) return false
  if (state.details_expanded) return false
  return card.collapsed
}

export const enqueueMessage = (state: ViewState, message: string): ViewState => ({
  ...state,
  queued: [...state.queued, message],
  queue_selected: -1,
})

export const dequeueMessage = (state: ViewState): { readonly next?: string; readonly state: ViewState } => {
  const [next, ...rest] = state.queued
  if (next === undefined) return { state }
  return { next, state: { ...state, queued: rest, queue_selected: -1 } }
}

export const queueUp = (state: ViewState): ViewState => {
  const count = state.queued.length
  if (count === 0) return state
  const next = state.queue_selected === -1 ? count - 1 : Math.max(0, state.queue_selected - 1)
  return { ...state, queue_selected: next }
}

export const queueDown = (state: ViewState): ViewState => {
  const count = state.queued.length
  if (count === 0 || state.queue_selected === -1) return state
  const next = state.queue_selected + 1
  return { ...state, queue_selected: next >= count ? -1 : next }
}

export const dequeueSelected = (state: ViewState): ViewState => {
  const index = state.queue_selected
  if (index < 0 || index >= state.queued.length) return state
  const queued = [...state.queued.slice(0, index), ...state.queued.slice(index + 1)]
  const selected = queued.length === 0 ? -1 : Math.min(index, queued.length - 1)
  return { ...state, queued, queue_selected: selected }
}

export const selectedQueued = (state: ViewState): string | undefined =>
  state.queue_selected >= 0 ? state.queued[state.queue_selected] : undefined

export const withReasoningDelta = (state: ViewState, text: string): ViewState => ({
  ...state,
  thinking: { ...state.thinking, text: `${state.thinking.text}${text}` },
})

export const toggleThinking = (state: ViewState): ViewState => ({
  ...state,
  thinking: { ...state.thinking, visible: !state.thinking.visible },
})

export const openPalette = (state: ViewState): ViewState => ({
  ...withoutNotice(state),
  palette_open: true,
  palette: { open: true, query: "", selected: 0 },
  shortcuts_open: false,
})

export const closePalette = (state: ViewState): ViewState => ({
  ...state,
  palette_open: false,
  palette: closedPalette,
})

export const paletteInsert = (state: ViewState, text: string): ViewState => ({
  ...state,
  palette: { ...state.palette, query: `${state.palette.query}${text}`, selected: 0 },
})

export const paletteBackspace = (state: ViewState): ViewState => ({
  ...state,
  palette: { ...state.palette, query: state.palette.query.slice(0, -1), selected: 0 },
})

export const paletteMove = (state: ViewState, delta: number, count: number): ViewState => {
  if (count <= 0) return { ...state, palette: { ...state.palette, selected: 0 } }
  const selected = (((state.palette.selected + delta) % count) + count) % count
  return { ...state, palette: { ...state.palette, selected } }
}

export const openShortcuts = (state: ViewState): ViewState => ({
  ...withoutNotice(state),
  shortcuts_open: true,
  palette_open: false,
  palette: closedPalette,
})

export const closeShortcuts = (state: ViewState): ViewState => ({ ...state, shortcuts_open: false })

export const openFilePicker = (state: ViewState, files: ReadonlyArray<string>): ViewState => ({
  ...withoutNotice(state),
  filepicker: { open: true, query: "", selected: 0, kind: "file", items: files.map((file) => ({ label: file, insert: file })) },
})

export const openThreadPicker = (state: ViewState, items: ReadonlyArray<PickerItem>): ViewState => ({
  ...withoutNotice(state),
  filepicker: { open: true, query: "", selected: 0, kind: "thread", items },
})

export const closeFilePicker = (state: ViewState): ViewState => ({ ...state, filepicker: closedFilePicker })

export const filePickerInsert = (state: ViewState, text: string): ViewState => ({
  ...state,
  filepicker: { ...state.filepicker, query: `${state.filepicker.query}${text}`, selected: 0 },
})

export const filePickerBackspace = (state: ViewState): ViewState => ({
  ...state,
  filepicker: { ...state.filepicker, query: state.filepicker.query.slice(0, -1), selected: 0 },
})

export const filePickerMove = (state: ViewState, delta: number, count: number): ViewState => {
  if (count <= 0) return { ...state, filepicker: { ...state.filepicker, selected: 0 } }
  const selected = (((state.filepicker.selected + delta) % count) + count) % count
  return { ...state, filepicker: { ...state.filepicker, selected } }
}

export const filteredPickerItems = (state: ViewState): ReadonlyArray<PickerItem> => {
  const needle = state.filepicker.query.trim().toLowerCase()
  const matches =
    needle.length === 0
      ? state.filepicker.items
      : state.filepicker.items.filter((item) => item.label.toLowerCase().includes(needle))
  return matches.slice(0, 50)
}

export const filteredFiles = (state: ViewState): ReadonlyArray<string> =>
  filteredPickerItems(state).map((item) => item.label)

export const acceptSelected = (state: ViewState): ViewState => {
  const item = filteredPickerItems(state)[state.filepicker.selected]
  return item === undefined ? closeFilePicker(state) : closeFilePicker(insertText(state, `@${item.insert} `))
}

export const tickSpinner = (state: ViewState): ViewState => ({
  ...state,
  spinner_index: (state.spinner_index + 1) % spinnerFrames.length,
})

const tick = tickSpinner

const applyMessage = (state: ViewState, event: Event.MessageAdded): ViewState => {
  const message = event.data.message
  const text = messageText(message)
  if (text.length === 0) return state
  const entry: ThreadMessage = { id: message.id, role: message.role, text }
  return {
    ...state,
    streaming_text: message.role === "assistant" ? "" : state.streaming_text,
    messages: [...state.messages, entry],
    entries: [...state.entries, { kind: "message", message: entry }],
  }
}

const skillCard = (event: Event.SkillLoaded): Card => ({
  id: event.id,
  kind: "skill",
  title: `Skill loaded: ${event.data.name}`,
  subtitle: event.data.source,
  status: "info",
  collapsed: true,
  body: [
    event.data.description,
    `File: ${event.data.skill_file}`,
    `Resources: ${event.data.resource_paths.join(", ")}`,
  ].join("\n"),
})

const subagentCard = (event: Event.SubagentCompleted): Card => ({
  id: event.id,
  kind: "subagent",
  title: `Subagent: ${event.data.name}`,
  subtitle: event.data.status,
  status: event.data.status === "completed" ? "success" : event.data.status === "failed" ? "error" : "info",
  collapsed: true,
  body: [event.data.summary, ...event.data.evidence.map((evidence) => `- ${evidence}`)].join("\n"),
})

const toolCard = (event: Event.ToolCallRequested): Card => ({
  id: event.data.call.id,
  kind: "tool",
  title: event.data.call.name,
  subtitle: toolTarget(event.data.call.input),
  status: "running",
  collapsed: true,
  body: jsonSummary(event.data.call.input),
})

const toolTarget = (input: unknown): string => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return ""
  const record = input as Record<string, unknown>
  const value = record.path ?? record.query ?? record.pattern ?? record.command ?? record.file
  if (typeof value === "string") return value
  const queries = record.queries
  if (Array.isArray(queries) && typeof queries[0] === "string") return queries[0]
  return ""
}

const applyToolResult = (state: ViewState, event: Event.ToolCallCompleted): ViewState => {
  const result = event.data.result
  const existing = state.cards.find((card) => card.id === result.id)
  const next = updateCard(state, {
    id: result.id,
    kind: "tool",
    title: result.name,
    subtitle: existing?.subtitle ?? "",
    status: result.status === "success" ? "success" : "error",
    collapsed: true,
    body: result.status === "success" ? jsonSummary(result.output) : (result.error?.message ?? "Tool failed"),
  })
  const diff = extractDiff(result.output)
  if (diff === undefined) return next
  return pushCard(next, {
    id: `${result.id}:diff`,
    kind: "diff",
    title: "File diff",
    subtitle: diff,
    status: result.status === "success" ? "success" : "error",
    collapsed: true,
    body: "Pierre diff metadata is available for expansion.",
  })
}

const errorCard = (event: Event.TurnFailed): Card => ({
  id: event.id,
  kind: "error",
  title: "Turn failed",
  subtitle: event.data.error.kind,
  status: "error",
  collapsed: false,
  body: event.data.error.message,
})

const systemCard = (title: string, subtitle: string, id: string): Card => ({
  id,
  kind: "system",
  title,
  subtitle,
  status: "info",
  collapsed: true,
})

const upsertCard = (cards: ReadonlyArray<Card>, card: Card): ReadonlyArray<Card> => {
  const index = cards.findIndex((existing) => existing.id === card.id)
  if (index < 0) return [...cards, card]
  return cards.map((existing, current) => (current === index ? card : existing))
}

const upsertCardEntry = (entries: ReadonlyArray<TranscriptEntry>, card: Card): ReadonlyArray<TranscriptEntry> => {
  const index = entries.findIndex((entry) => entry.kind === "card" && entry.card.id === card.id)
  if (index < 0) return [...entries, { kind: "card", card }]
  return entries.map((entry, current) => (current === index ? { kind: "card", card } : entry))
}

const pushCard = (state: ViewState, card: Card): ViewState => ({
  ...state,
  cards: [...state.cards, card],
  entries: [...state.entries, { kind: "card", card }],
})

const updateCard = (state: ViewState, card: Card): ViewState => ({
  ...state,
  cards: upsertCard(state.cards, card),
  entries: upsertCardEntry(state.entries, card),
})

const messageText = (message: Message.Message) =>
  message.content
    .filter((part): part is Message.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

const jsonSummary = (value: Common.JsonValue | undefined) => {
  if (value === undefined) return ""
  const text = JSON.stringify(value, undefined, 2)
  if (text.length <= 800) return text
  return `${text.slice(0, 800)}\n… truncated`
}

const extractDiff = (value: Common.JsonValue | undefined): string | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractDiff(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!isJsonObject(value)) return undefined
  if (isPierreDiff(value)) return diffSubtitle(value)
  for (const child of Object.values(value)) {
    const found = extractDiff(child)
    if (found !== undefined) return found
  }
  return undefined
}

const isPierreDiff = (value: Record<string, Common.JsonValue>) =>
  value.kind === "diff" && value.renderer === "@pierre/diffs"

const diffSubtitle = (value: Record<string, Common.JsonValue>) => {
  const fileDiff = value.file_diff
  if (isJsonObject(fileDiff)) {
    const name = fileDiff.name
    if (typeof name === "string") return `${name} · collapsed`
  }
  return "collapsed"
}

const isJsonObject = (value: Common.JsonValue | undefined): value is Record<string, Common.JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
