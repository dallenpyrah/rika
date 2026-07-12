# Rika Product

Rika is a personal, local-only coding agent that lives in the terminal. It combines an Amp-quality interaction model with Effect-native architecture, Baton agent execution, Relay durability, Effect SQL persistence, and OpenTUI rendering.

Rika is for one owner working in local repositories. It is not a hosted collaboration product and does not include accounts, pricing, remote control, web clients, IDE clients, or remote development environments.

## Product Promise

Rika can inspect, edit, review, test, and extend local software projects through durable agent threads. Active work, parallel subagents, approvals, and workflows survive process termination and resume from local SQLite state.

## Design Principles

- Local-first means local authority, local storage, and no mandatory Rika service.
- Modes describe outcomes and autonomy, not provider implementation details.
- The TUI makes agent work legible while it happens.
- Tools are typed capabilities, not arbitrary model privileges.
- Durable work has one authority and one replay story.
- Framework capabilities are consumed through package contracts rather than copied.
- The simplest architecture that supports durable multi-agent work wins.

## Modes

| Mode     | Intent                                | Initial route  |
| -------- | ------------------------------------- | -------------- |
| `low`    | Small, precisely scoped work          | GPT-5.6 Terra  |
| `medium` | Default multi-file work               | GPT-5.6 Luna   |
| `high`   | Difficult and subtle work             | GPT-5.6 Sol    |
| `ultra`  | Architecture and open-ended discovery | Claude Fable 5 |

Oracle routes are mode-dependent and may use Claude Sonnet 5, Claude Opus 4.8, or GPT-5.6 Sol. Stable mode meanings do not change when provider routing changes.

## Non-Goals

- Amp protocol or branding compatibility.
- Hosted thread URLs or social sharing.
- Enterprise administration.
- Remote agents or sandbox orchestration.
- WebSocket transport when no process boundary exists.
- A generic public agent SDK.
- Provider-specific user-facing model configuration as the default interaction.
