# Amp feature inventory → Rika parity map

Every Amp feature from the Owner's Manual, mapped to where it lives in Rika and
its parity status. This is the master "what does Amp do" list referenced by
`goal.md`. Keep it current: when you verify a feature with side-by-side
evidence, flip its status and link the `SCREENSHOT_LOG.md` row.

Status: `unverified` (claimed in code, not visually compared) · `partial` ·
`mismatch` · `match` (indistinguishable, evidence logged) · `gap` (missing).

## Modes & models
| Feature | Amp behavior | Rika location | Status |
| --- | --- | --- | --- |
| Agent modes | `deep` (GPT-5.5 + extended thinking), `smart` (Opus 4.8), `rush` (fast GPT-5.5) | `packages/llm/src/modes.ts` | unverified |
| Mode switch | `Ctrl+S`; palette `mode` | `packages/tui/` keymap/palette | unverified |
| Reasoning effort toggle | `Alt+D` cycles effort per mode | `packages/tui/` (`cycleReasoning`) | unverified |
| Fast mode toggle | `Alt+R` | `packages/tui/` (`toggleFastMode`) | unverified |
| Model routing per task | Review→GPT-5.5, Search→Gemini 3 Flash, Oracle→GPT-5.5, etc. | `packages/llm/` | unverified |

## Prompting & input
| Feature | Amp behavior | Rika location | Status |
| --- | --- | --- | --- |
| Submit / newline | Enter submits; Shift+Enter / Ctrl+J / `\`+Enter newline | `packages/tui/` input | unverified |
| Queue messages | type while busy → queued; Enter Enter steer; Esc Esc interrupt | `packages/tui/` (`enqueueMessage`/`dequeue`) | unverified |
| Edit prior message | Tab to navigate, `e` to edit | `packages/tui/` (`navPrev/Next`, `editNav`) | unverified |
| Prompt history | `Ctrl+R` | `packages/tui/` (`historyPrev/Next`) | unverified |
| Open prompt in `$EDITOR` | `Ctrl+G` | `packages/tui/` | unverified |
| Image paste | `Ctrl+V` paste from clipboard | `packages/tui/` | gap? |
| `@file` mention | `@` fuzzy file picker | `packages/tui/` (`FilePickerState`) | unverified |
| `@@` thread mention | search threads to mention | `packages/agent/` thread service | unverified |

## Threads
| Feature | Amp behavior | Rika location | Status |
| --- | --- | --- | --- |
| Durable threads | create/open/list/search/archive/share/reference | `packages/agent/src/thread-service.ts` | unverified |
| Switch thread | thread switcher UI | `packages/tui/` (`withThread`) | unverified |
| Archive | `Ctrl+C Ctrl+N` (archive+new), `Ctrl+C Ctrl+E` (archive+quit), palette | `packages/tui/` | unverified |
| Reference threads | by URL / `@T-…` id | `packages/agent/` | unverified |
| Find threads | search by keyword/file/repo/author/date | `packages/agent/` | unverified |
| Thread visibility / sharing | private/workspace/group/unlisted | `packages/server/`, `packages/agent/` | unverified |
| Remote control | continue CLI thread from web | `packages/server/`, `packages/sdk/` | unverified |

## Tools & subagents
| Feature | Amp behavior | Rika location | Status |
| --- | --- | --- | --- |
| Built-in tools list | `amp tools list` | `packages/tools/` | unverified |
| File find/search | ripgrep → **Rika: fff** (deliberate, §3) | `packages/tools/src/fff-search.ts` | unverified |
| Read/edit | hashline read/edit | `packages/tools/src/hashline-file.ts` | unverified |
| Semantic search | **Rika addition** (§3) | `packages/tools/` | unverified |
| AST-grep outline | **Rika addition** (§3) | `packages/tools/src/ast-grep-outline.ts` | unverified |
| Subagents | own context, own tools, parallel, final-summary, auto-spawn | `packages/agent/src/subagent-runtime.ts` | **gap — see goal.md §4** |
| Oracle | GPT-5.5 second-opinion tool | `packages/tools/src/specialty-tools.ts` | unverified |
| Librarian | cross-repo / GitHub code search subagent | `packages/tools/src/specialty-tools.ts` | unverified |
| Painter | image gen/edit tool | `packages/tools/src/specialty-tools.ts` | unverified |
| Code review | `amp review` + checks subagents | `packages/agent/src/review-service.ts` | unverified |

## Guidance, skills, plugins, MCP
| Feature | Amp behavior | Rika location | Status |
| --- | --- | --- | --- |
| AGENTS.md resolution | cwd+parents+subtree+global, globs, `@`-mentions | `packages/agent/src/context-resolver.ts` | unverified |
| Skills | discovery/list/inspect/load, precedence order | `packages/agent/src/skill-registry.ts` | unverified |
| Plugins | TS plugin host: events/tools/commands/UI/ai.ask | `packages/plugin/src/plugin-host.ts` | unverified |
| Self-extension | generate/verify/enable/disable/rollback skills+plugins | `packages/plugin/src/self-extension.ts` | unverified |
| MCP | local+remote servers, approval, permissions | `packages/tools/src/mcp-client.ts` | unverified |
| Permissions | default allow-all; policy plugin overrides | `packages/agent/` PermissionPolicy | unverified |

## CLI & integrations
| Feature | Amp behavior | Rika location | Status |
| --- | --- | --- | --- |
| Interactive CLI | `rika` | `packages/cli/`, `packages/tui/` | unverified |
| Execute mode | `-x` / stdout redirect | `packages/cli/src/execute.ts` | unverified |
| Streaming JSON | `--stream-json[-input][-thinking]` | `packages/cli/` | unverified |
| Command palette | `Ctrl+O` | `packages/tui/src/palette.ts` | unverified |
| Keybindings | full keymap; `amp config keymap` equiv | `packages/tui/src/keymap.ts` | unverified |
| IDE integration | VS Code/JetBrains/Neovim/Zed seam | `packages/ide/` | unverified |
| Config/settings | `amp.*` settings, user+workspace precedence | `packages/cli/`, `packages/core/` | unverified |
| Notifications | sound/bell on done/blocked | `packages/tui/` | unverified |

## UI chrome (the nitpicky visual surface — see goal.md §6)
| Feature | Amp behavior | Rika location | Status |
| --- | --- | --- | --- |
| Startup screen | wordmark/version/tips/model line | `packages/tui/` | unverified |
| Status line | mode/model/effort/fast/branch/cost | `packages/tui/src/view-state.ts` | unverified |
| Tool-call card collapse/expand (click + key) | click to toggle; Alt+T | `packages/tui/` (`toggleDetails`, `isCardCollapsed`, `focusPrev/Next`) | unverified |
| Thinking block | reasoning render + toggle | `packages/tui/` (`toggleThinking`, `withReasoningDelta`) | unverified |
| Spinner | frames + placement | `packages/tui/` (`spinnerFrames`) | unverified |
| Scroll-while-streaming | hold position mid-stream | `packages/tui/` | unverified |
| Diff rendering | add/remove colors, file header | `packages/tui/` (`diff` card) | unverified |
| Cost display | per-thread cost line | `packages/tui/` | unverified |
