export interface Command {
  readonly id: string
  readonly category: string
  readonly action: string
  readonly hint: string
  readonly command: string
  readonly key?: string
}

export const commands: ReadonlyArray<Command> = [
  { id: "mode", category: "mode", action: "switch rush · smart · deep", hint: "switch agent mode", command: "/mode", key: "Ctrl+S" },
  { id: "new", category: "thread", action: "new", hint: "start a new durable thread", command: "/new", key: "Ctrl+C Ctrl+N" },
  { id: "threads", category: "thread", action: "list", hint: "list active threads", command: "/threads" },
  { id: "thread", category: "thread", action: "resume", hint: "resume a durable thread", command: "/thread" },
  { id: "search", category: "thread", action: "search", hint: "search local threads", command: "/search" },
  { id: "archive", category: "thread", action: "archive", hint: "archive a thread", command: "/archive" },
  { id: "unarchive", category: "thread", action: "unarchive", hint: "restore an archived thread", command: "/unarchive" },
  { id: "share", category: "thread", action: "share export", hint: "show local thread export JSON", command: "/share" },
  { id: "reference", category: "thread", action: "reference", hint: "compact thread reference", command: "/reference" },
  { id: "skills", category: "skills", action: "list", hint: "list installed skills", command: "/skills" },
  { id: "skill", category: "skills", action: "inspect", hint: "inspect a skill by name", command: "/skill" },
  { id: "review", category: "review", action: "run", hint: "run a code review", command: "/review" },
  { id: "help", category: "rika", action: "toggle shortcuts", hint: "show keyboard shortcuts", command: "/help", key: "?" },
  { id: "exit", category: "rika", action: "quit", hint: "leave Rika", command: "/exit", key: "Ctrl+C Ctrl+C" },
]

const normalize = (query: string) => query.trim().toLowerCase().replace(/^\//, "")

export const filter = (query: string): ReadonlyArray<Command> => {
  const needle = normalize(query)
  if (needle.length === 0) return commands
  return commands.filter(
    (command) =>
      command.id.includes(needle) ||
      command.category.toLowerCase().includes(needle) ||
      command.action.toLowerCase().includes(needle) ||
      command.hint.toLowerCase().includes(needle),
  )
}

export const at = (query: string, index: number): Command | undefined => {
  const results = filter(query)
  if (results.length === 0) return undefined
  const clamped = Math.min(Math.max(index, 0), results.length - 1)
  return results[clamped]
}
