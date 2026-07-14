# Rika V2 Plan

## Objective

Build Rika v2 as a local-only personal coding-agent CLI and OpenTUI application with the useful personal feature surface of Amp Code and Rika v1, without Rivet, remote control, web, IDE, or hosted product infrastructure.

Rika's committed and release-verified dependency contract consumes Baton and Relay as released package dependencies:

```text
Rika -> @relayfx/sdk -> @batonfx/core -> Effect AI
```

Rika may consume focused Baton packages directly where they are the public integration boundary, including providers, skills, MCP, and deterministic tests. Coordinated local development may use the explicit non-persistent `upstream:link` overlay; Rika does not copy, vendor, fork, deep-import, or commit workspace/file links to Baton or Relay source.

## Product Constraints

- Local-only and single-user.
- One packaged Bun CLI with an OpenTUI interface.
- Effect v4 and Effect-native APIs at every available boundary.
- Effect CLI for all command parsing, help, validation, and process entrypoints.
- Effect SQL with SQLite for local product state.
- Relay is the sole durable execution authority.
- Baton is the sole agent-loop authority.
- One Resident Rika Service per canonical Profile/data root owns product SQLite, one Relay runtime/SQLite, execution admission, reconciliation, and runtime fibers. Execution-capable CLI and TUI clients converge through an authenticated, versioned loopback WebSocket listener.
- No SSE for Rika-owned live execution/control transport. Provider and MCP package internals follow their published contracts.
- No Rivet or Rivet actors.
- No semantic search tool.
- No ast-grep outline tool.
- No legacy Amp or Rika modes.
- No login, pricing, hosted accounts, web, IDE, remote runners, or orbs.
- Preserve Rika v1's visual language and interaction quality.

## Source Repositories

- Frozen v1 reference: `/Users/dallen.pyrah/projects/rika-old`
- Historical broader implementation and Amp parity evidence: `/Users/dallen.pyrah/projects/rika-rivet`
- Baton source of truth: `/Users/dallen.pyrah/projects/batonfx`
- Relay source of truth: `/Users/dallen.pyrah/projects/relay`

The v1 repository was renamed with its existing uncommitted and untracked work intact. It is reference material, not a workspace dependency.

## Dependency Policy

- Pin exact registry releases in `bun.lock`.
- Use catalog versions for third-party dependencies within this monorepo.
- Never use `file:`, `link:`, or external `workspace:*` dependencies for Baton or Relay.
- Never deep-import Baton or Relay source files.
- Rika imports only documented package exports.
- Missing framework behavior is implemented and released upstream first.
- Effect and every `@effect/*` package use one compatible version family.
- Direct provider SDKs are forbidden. Model calls flow through Baton and Effect AI.

Registry versions observed at project creation:

| Package         | Observed version |
| --------------- | ---------------- |
| `@batonfx/core` | `0.4.0`          |
| `@relayfx/sdk`  | `0.0.50`         |

These observations are not an automatic compatibility approval. Installed package source and exports must be verified after installation.

## Architecture

```text
+---------------------------+
| apps/rika                 |
| Effect CLI + Bun runtime  |
+-------------+-------------+
              |
              v
+---------------------------+
| @rika/app                 |
| Product orchestration     |
| Modes and thread actions  |
+------+------+-------------+
       |      |
       |      +-----------------------+
       v                              v
+--------------+             +------------------+
| @rika/tools  |             | @rika/extensions|
| Coding tools |             | Skills/MCP/plugin|
+------+-------+             +---------+--------+
       |                               |
       +---------------+---------------+
                       |
                       v
              +------------------+
              | @relayfx/sdk     |
              | Durable execution|
              | Children/waits   |
              +--------+---------+
                       |
                       v
              +------------------+
              | @batonfx/core    |
              | Agent loop/tools |
              +--------+---------+
                       |
                       v
              +------------------+
              | Effect AI        |
              +------------------+

+----------------------+  +----------------------+
| @rika/persistence    |  | @rika/tui            |
| Effect SQL product DB|  | Pure state + OpenTUI |
+----------------------+  +----------------------+
```

## Package Plan

| Package             | Responsibility                                                 | Must not import                  |
| ------------------- | -------------------------------------------------------------- | -------------------------------- |
| `apps/rika`         | Effect CLI tree, runtime assembly, process lifecycle           | Provider SDKs, raw SQL           |
| `@rika/app`         | Product modes, commands, thread metadata, execution projection | OpenTUI, provider SDKs, raw SQL  |
| `@rika/config`      | Settings, environment decoding, model aliases, keymap          | OpenTUI, Relay runtime internals |
| `@rika/extensions`  | Skills, MCP, plugins, custom agents and modes                  | OpenTUI, raw provider clients    |
| `@rika/persistence` | Effect SQL schema, migrations, repositories                    | OpenTUI, provider SDKs           |
| `@rika/tools`       | Typed local coding tools and product permission metadata       | OpenTUI, raw model clients       |
| `@rika/tui`         | Pure terminal state and the only OpenTUI adapter               | SQL, providers, Relay internals  |

Packages are created only when their boundaries are needed by an implemented vertical slice.

## Execution Phases

### Phase 0: Preserve and Specify

- Rename v1 to `rika-old` without modifying its worktree.
- Create the new repository.
- Write `PLAN.md`, `TODO.md`, `PRODUCT.md`, `CONTEXT.md`, `SPEC.md`, feature inventory, specs, and ADRs.
- Record Amp, Rika v1, retained, excluded, and deferred features independently.
- Establish status values and evidence requirements.

Exit gate: every planned public feature maps to a spec branch and implementation status.

### Phase 1: Dependency and API Proof

- Install published Baton and Relay packages.
- Inspect their installed package exports and Effect version requirements.
- Inspect installed Effect CLI, SQL, WebSocket, Stream, Layer, Scope, Cluster, and Workflow source.
- Build clean external-consumer smoke programs for Baton and Relay.
- Identify missing upstream Relay capabilities for parallel children and workflows.
- Block on a Relay release whose root import succeeds in a clean consumer without undeclared dialect dependencies.
- Prove Relay and Rika migration discovery, ordering, locking, repeated startup, interruption behavior, and packaged assets.
- Produce Relay capability and Baton-event coverage matrices before runtime implementation.

Exit gate: a documented supported dependency graph compiles without source links, internal imports, or undeclared implementation dependencies; clean SQLite startup applies all required migrations.

### Phase 2: Repository Foundation

- Add Bun/Turbo workspace configuration.
- Add Oxlint and Prettier.
- Add TypeScript project references.
- Add documentation consistency checks.
- Add dependency-boundary checks.
- Add package skeletons only for the first vertical slice.

Exit gate: format, lint, typecheck, test, build, and docs checks run successfully.

### Phase 3: Effect CLI Foundation

- Build all command surfaces with `effect/unstable/cli`.
- Leaf modules export command values. The root CLI exports the command tree and `run(argv)`; the app entrypoint alone defines and interprets `main`.
- Use typed `Flag` and `Argument` schemas.
- Keep behavior behind Effect services.
- Use Effect platform services for terminal and standard I/O.
- Test command parsing without spawning processes.
- Prove help, version, completions, and parse errors without initializing SQL, Relay, models, MCP, plugins, or OpenTUI.

Exit gate: root help, version, execute, thread, config, MCP, skill, tool, review, and doctor command shapes are represented in the command tree with tests.

### Phase 4: Durable Runtime Vertical Slice

- Compose embedded Relay over SQLite inside one Resident Rika Service per canonical Profile/data root.
- Bind the service's authenticated loopback listener before database startup; concurrent execution-capable starters attach to the winner instead of opening state or failing due to another client.
- Keep help, version, and parsing local and lazy; route every product-state operation through the resident while keeping CLI parsing/output and TUI rendering/input in clients.
- Apply Relay and Rika migrations before runtime composition.
- Register Baton-backed model execution through supported package APIs.
- Create a thread, start an execution, stream events, finish, restart, and reopen.
- Keep Relay identifiers behind `@rika/app` contracts.
- Prove cancellation and cursor replay.
- Implement deterministic Turn/Execution identity and startup reconciliation across the Rika and Relay stores.

Exit gate: a packaged CLI completes and reopens one real model-backed thread.

### Phase 5: OpenTUI Vertical Slice

- Port the Rika v1 pure view model and renderer styling.
- Remove Rivet, orb, remote, IDE, semantic-search, and ast-grep-outline assumptions.
- Render Relay/Baton events through product-owned view messages.
- Add character-frame tests and visual captures.

Exit gate: welcome, prompt, streaming response, tool card, diff, mode picker, palette, and restart replay match the Rika v1 visual baseline.

### Phase 6: Coding Tools

- File discovery.
- Grep/content search.
- Read and media view.
- Patch/create/edit.
- Shell execution and status.
- Git inspection.
- Web search and page reading.
- Thread find/read.
- Specialty agents and image generation.

Every tool requires Schema input, typed output, tagged errors, permission classification, timeout, bounded output, a test layer, and deterministic agent-loop tests.

### Phase 7: Context and Extensions

- Hierarchical `AGENTS.md` and fallback guidance.
- File and thread mentions.
- Skills with lazy activation.
- Skill-bundled MCP.
- Local and remote MCP.
- MCP OAuth where package support exists.
- Workspace MCP trust decisions.
- Local TypeScript plugins.
- Custom agents and modes.
- Tool-call policy hooks.
- Pin extension generations and tool-schema digests for active and resumed executions.

### Phase 8: Amp Personal CLI Parity

- Prompt queueing and steering.
- Prior-message editing and forking.
- Multiple active threads and sidebar.
- Thread lifecycle and export commands.
- Automatic compaction and context analysis.
- Context references and globs are workspace-bounded. Typed file, image, and thread mentions are projected into resolved execution context. Baton owns compaction; Relay event metadata is the durable checkpoint authority and replay suppresses duplicate checkpoint emission. Product views consume the shared context-usage analysis and formatter.
- Image input.
- Shell and incognito-shell input.
- Execute and JSONL automation.
- Review command and checks.
- Notifications, cost display, diagnostics, and keymap.

Exit gate: every included row in `docs/features/FEATURES.md` is implemented and has evidence.

### Phase 9: Durable Multi-Agent Execution

- Parallel child runs.
- Bounded fan-out.
- Durable all/first-success/quorum/best-effort joins.
- Child and parent cancellation.
- Partial failures.
- Automatic subagent selection.
- Parallel review lanes.
- Process-death recovery during active children.

This phase is blocked until released Relay APIs provide concurrent fan-out, aggregate durable joins, deterministic event allocation, cancellation propagation, and restart tests. Baton in-process fan-out is not an acceptable durability substitute.

Exit gate: restart tests prove monotonic events, resumed parent completion, and no duplicated visible side effects.

### Phase 10: Dynamic Workflows

- Define a versioned Rika workflow schema.
- Compile workflow operations to supported Relay primitives.
- Support sequence, parallel, branch, join, approval, timer, retry, budget, cancellation, and compensation.
- Permit typed dynamic extension without arbitrary generated code execution.
- Pin workflow definitions for replay.

This phase is blocked until Relay publishes the durable primitives or a supported generic workflow contract. Rika does not implement a hidden product-local workflow engine.

Exit gate: real investigate/implement/review/fix/verify and parallel-research/synthesis workflows survive process termination.

### Phase 11: Packaging and Release Proof

- Build platform-specific OpenTUI binaries.
- Bundle local migrations and assets.
- Verify clean-home installation.
- Verify no Rivet binaries, daemon, Docker, or Postgres requirement.
- Run all real user flows against the packaged artifact.

## Oracle Review Gates

Oracle review is required at these gates:

1. Initial architecture, feature inventory, and ADR set.
2. Installed dependency/API proof.
3. Effect CLI command architecture.
4. Relay/Baton vertical slice.
5. TUI port and visual test strategy.
6. Tool and permission boundary.
7. Multi-agent durability design.
8. Dynamic workflow design.
9. Final diff and verification evidence.

Each review must be read-only, cite concrete files, identify correctness risks and missing verification, and have findings resolved or recorded before the gate closes.

## Published Relay Readiness Matrix

| Capability                            | `@relayfx/sdk@0.0.50`                        | Rika disposition           |
| ------------------------------------- | -------------------------------------------- | -------------------------- |
| Clean root import in a fresh consumer | Broken by undeclared MySQL import            | Upstream release blocker   |
| Embedded SQLite runtime               | Present but requires migration/package proof | Phase 1 proof              |
| Sequential durable child spawn        | Present                                      | Usable after package proof |
| Single-child durable wait             | Present                                      | Usable after package proof |
| Parent cancellation propagation       | Present                                      | Usable after package proof |
| Concurrent durable fan-out            | Not released                                 | Upstream blocker           |
| Aggregate durable joins               | Not released                                 | Upstream blocker           |
| Generic versioned workflows           | Not released                                 | Upstream blocker           |
| Persisted dynamic workflow fragments  | Not released                                 | Upstream blocker           |
| Durable tool progress events          | Not established                              | Event coverage blocker     |
| Durable structured output events      | Not established                              | Event coverage blocker     |

## Verification Commands

```bash
bun install
bun run docs:check
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run test:agent-harness
bun run test:e2e
bun run test:coverage
bun run build
bun run package:smoke
```

## Completion Definition

Rika v2 is complete when:

- Every included feature row is implemented and evidenced.
- Every excluded row is absent from code and dependencies.
- Relay is the only durable execution authority.
- Baton is the only agent-loop authority.
- All commands use Effect CLI.
- All product persistence uses Effect SQL services.
- All client-to-resident-service live execution/control uses the authenticated, versioned Rika WebSocket protocol.
- Parallel agents and dynamic workflows survive process death.
- The packaged TUI matches the approved Rika v1 visual baseline.
- Full local verification passes.
- Measured first-party source coverage is at least 95% for statements, branches, functions, and lines.
- Packaged CLI and native OpenTUI E2E flows pass against real process boundaries.
- Deterministic fake-model suites prove long tool loops, approvals, steering, subagents, joins, restarts, and workflows.
- Opt-in live-model suites pass through the configured OpenAI-compatible endpoint without logging credentials.
- Final oracle reviews have no unresolved critical or high-severity findings.
