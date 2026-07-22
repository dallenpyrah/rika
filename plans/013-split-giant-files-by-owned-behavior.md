# Plan 013: Split every giant TypeScript file by owned behavior

> **Executor instructions**: This is a sequence of behavior-preserving file
> moves, not a redesign. Complete one step at a time, run its focused checks,
> and keep each step independently reviewable. Run the final verification in
> full. If a STOP condition occurs, stop and report rather than changing a
> contract to make the extraction easier.
>
> **Drift check (run first)**:
>
> ```sh
> git diff --stat a35b4e16f942..HEAD -- \
>   apps/rika/src/main.ts \
>   apps/rika/src/resident-client-transport.ts \
>   apps/rika/src/resident-host-transport.ts \
>   packages/app/src/operation.ts \
>   packages/persistence/src/turn-repository.ts \
>   packages/runtime/src/execution-backend.ts \
>   packages/tui/src/adapter.ts \
>   packages/tui/src/view-state.ts
> ```
>
> If an in-scope file changed, remap the named seams against the live code
> before moving it. Drift alone is not a reason to discard unrelated work.
>
> **Boundary**: Never edit, import from, format, build, or test `repos/*`.
> Use only released Effect, Relay, Baton, and OpenTUI package exports.

## Status

- **Priority**: P2
- **Effort**: XL, delivered as independent slices
- **Risk**: MED
- **Depends on**: plans 002 and 003 landed, then drift rebaselined
- **Category**: structure
- **Planned at**: commit `a35b4e16f942`, 2026-07-21
- **Issue**: —

## Outcome

Split every first-party TypeScript file over 1,000 lines at the planning
baseline into files named for one owned behavior. Preserve runtime behavior,
Effect topology, SQL transaction boundaries, public package entry points,
wire schemas, and user-visible output.

The target is normally 150–350 lines per file. A file over 500 lines needs a
specific cohesion justification in review; a compatibility facade should be
small. The line target is a review tripwire, not permission to split one
state transition across arbitrary files.

This plan covers eight production owners and the ten giant test files coupled
to them:

| Owner                        | Baseline giant files                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| CLI composition              | `apps/rika/src/main.ts` (3,139)                                                                                |
| Resident transport           | `resident-client-transport.ts` (1,237), `resident-host-transport.ts` (1,018)                                   |
| App operation                | `packages/app/src/operation.ts` (3,840), `operation.test.ts` (4,004), `interactive-session.test.ts` (1,159)    |
| Turn persistence             | `turn-repository.ts` (1,136), `sqlite.test.ts` (1,292)                                                         |
| Relay backend                | `execution-backend.ts` (2,150), `execution-backend.test.ts` (2,063), `execution-backend-relay.test.ts` (1,123) |
| Transcript projection        | `packages/transcript/test/projection.test.ts` (1,194)                                                          |
| TUI adapter                  | `adapter.ts` (4,030), `adapter.test.ts` (2,131), `opentui-adapter.test.ts` (2,967)                             |
| TUI state                    | `view-state.ts` (1,967), `view-state.test.ts` (1,350)                                                          |
| Interactive controller tests | `apps/rika/test/interactive-controller.test.ts` (1,368)                                                        |

`packages/transcript/src/index.ts` (964) and
`apps/rika/src/interactive-controller.ts` (540) are not production split
targets: neither crossed the baseline. Their giant tests still split by the
behaviors already owned by those modules. Re-run the inventory at the end and
report any new file over 1,000 lines rather than silently expanding scope.

## Non-negotiable invariants

1. **No product or behavior change.** Move existing code and tests. Do not
   alter algorithms, timing, queue capacities, retries, error mapping, copy,
   status, projection, rendering, or transport semantics.
2. **No SOLID redesign.** Do not introduce repositories, ports, strategies,
   service interfaces, dependency-injection frameworks, or generalized
   abstractions. A small parameter object is allowed only to pass dependencies
   currently captured by one large closure.
3. **Stable public imports.** Keep these entry points and exports compatible:
   `@rika/app`, `@rika/app/operation`, `@rika/runtime/relay`, `@rika/tui`,
   `@rika/tui/adapter`, `@rika/persistence`, and
   `@rika/persistence/turn-repository`.
4. **Process boundaries do not move.** At this baseline both
   `apps/rika/src/client-main.ts` and `apps/rika/src/main.ts` call
   `BunRuntime.runMain`; `main.ts` also uses `Effect.runSync` for its Path
   service and environment read. This conflicts with the current CLI guidance
   that `main.ts` alone interprets the product process, but resolving that
   existing conflict is not part of a file move. Preserve those existing
   `runMain` and `runSync` call sites exactly and do not add another one.
5. **Lazy CLI startup.** Help, version, and parse failures must not initialize
   SQL, Relay, models, MCP, plugins, OpenTUI, or the resident service.
6. **Framework boundaries stay put.** Relay owns execution, Baton owns the
   agent loop, Rika owns product projections, Effect SQL remains the database
   API, and OpenTUI remains behind renderer-facing TUI modules.
7. **Effect behavior stays identical.** Preserve scope ownership, fork
   supervision, interruption, queue/backpressure capacities, schedules,
   layer memoization, acquisition order, and the locations where Effects are
   interpreted.
8. **No import cycles.** Dependency direction is contract/pure code → adapter
   code → composition facade. Extracted children never import their facade.
9. **No catch-all modules.** Do not create `utils`, `helpers`, `common`,
   `shared`, or `lib`; name each file for the behavior it owns.
10. **Tests move without weakening.** Do not delete, merge away, skip, or
    broaden assertions. Shared test fixtures may be extracted, but every test
    keeps the same level and real-vs-scripted adapter boundary.

## Target ownership tree

Names may be adjusted to match live symbols, but ownership and dependency
direction should remain as follows.

```text
apps/rika/src/
├── main.ts                         # existing private-runtime process boundary
├── cli-program.ts                  # Command.run and CLI error rendering
├── client-dispatch.ts              # post-parse workspace + resident dispatch
├── workspace-files.ts              # paths, changed files, editor/open actions
├── prompt-attachments.ts           # image validation/materialization/persistence
├── model-routing.ts                # route planning, pins, restoration
├── backend-composition.ts          # configured and lazy backend Layers
├── operation-composition.ts        # productLayer dependencies; returns Layers
├── resident-owner.ts               # cached Operation.Service owner
├── tui-program.ts                  # interactive OpenTUI/session lifecycle
├── tui-lifecycle.ts                # signal/fiber/switcher initialization policies
├── resident-client-transport.ts    # compatibility facade
├── resident-client/
│   ├── close-policy.ts
│   ├── connection.ts
│   ├── requests.ts
│   ├── event-delivery.ts
│   ├── reconnect.ts
│   └── acquire.ts
├── resident-host-transport.ts      # compatibility facade
└── resident-host/
    ├── interactive-feed.ts
    ├── request-routing.ts
    ├── connection.ts
    └── server-lifecycle.ts

packages/app/src/
├── operation.ts                    # compatibility facade
└── operation/
    ├── options.ts
    ├── auth.ts
    ├── reconcile.ts
    ├── execution-projection.ts
    ├── execution-preparation.ts
    ├── execution-coordination.ts
    ├── interactive-session.ts
    ├── interactive-feed.ts
    ├── interactive-execution.ts
    ├── interactive-queue.ts
    ├── interactive-history.ts
    ├── interactive-controls.ts
    ├── dispatch.ts
    ├── product-layer.ts
    └── test-layer.ts

packages/persistence/src/
├── turn-repository.ts              # compatibility facade
└── turn-repository/
    ├── contract.ts
    ├── codec.ts
    ├── memory.ts
    └── sqlite.ts

packages/runtime/src/
├── execution-backend.ts            # compatibility facade
└── relay/
    ├── options.ts
    ├── identities.ts
    ├── routes.ts
    ├── models.ts
    ├── tools.ts
    ├── execution-codec.ts
    ├── execution-follow.ts
    ├── client-layer.ts
    ├── children.ts
    ├── fan-out.ts
    ├── workflows.ts
    ├── host-handlers.ts
    └── embedded-layer.ts

packages/tui/src/
├── view-state.ts                   # namespace compatibility facade
├── view-state/
│   ├── model.ts
│   ├── queue.ts
│   ├── layout.ts
│   ├── composer.ts
│   ├── transcript.ts
│   └── navigation.ts
├── adapter.ts                      # public compatibility facade
└── adapter/
    ├── contract.ts
    ├── block-renderer.ts
    ├── changed-files-renderer.ts
    ├── composer-renderer.ts
    ├── overlay-renderer.ts
    ├── sidebar-renderer.ts
    ├── thread-switcher-renderer.ts
    ├── welcome-renderer.ts
    ├── transcript-renderer.ts
    ├── renderables.ts
    ├── input-events.ts
    ├── reconcile.ts
    └── surface.ts
```

Do not duplicate the existing `packages/tui/src/transcript-presenter/` or
`transcript-viewport.ts`; extracted adapter code consumes those owners.
Likewise, reuse `agent-profiles.ts`, `agent-depth.ts`, `agent-model.ts`,
`thread-host.ts`, and `workflow-definitions.ts` rather than wrapping them.

## Step 1 — Split giant tests first, without product changes

Move tests into files named for the behavior under test while they still
import the existing facades. Extract only fixture builders that are reused by
at least two resulting files.

- App: reconciliation, projection, interactive feed, interactive queue,
  interactive history, dispatch/thread actions, review, and test layer.
- Runtime: codec/routes, child results, client lifecycle, controls,
  fan-out/workflows, embedded Relay, and resilience.
- TUI: block/transcript/sidebar/overlay renderers; Surface lifecycle, input,
  scrolling, composer, queue, sidebar, and animation; ViewState queue,
  composer, transcript, navigation, and loadables.
- CLI controller: selection/page projection, child projection, activity,
  queue, and frame batching.
- Persistence: migration lifecycle, turn repository, queue transactions,
  concurrency, and query-plan assertions.
- Transcript: turn projection, tools, child runs, permissions, usage, and
  terminal/error projection.

Keep test locations under each package's existing `test/` directory. Do not
co-locate them under `src/` and do not change Unit tests into Scenes or
Journeys.

Verification:

```sh
bun run test-unit
```

Expected: the same test count and outcomes as before the moves. Record the
before/after test counts in the review description.

## Step 2 — Extract the turn repository

This is the smallest production split and establishes the facade pattern.

1. Move schemas, service contract, errors, and exported types to
   `turn-repository/contract.ts`; move row encode/decode only to `codec.ts`.
2. Move the in-memory implementation unchanged to `memory.ts`.
3. Move the Effect SQL implementation unchanged to `sqlite.ts`.
4. Keep each existing `sql.withTransaction(Effect.gen(...))` block intact.
   Queue claim/edit/delete/requeue/wake operations must not be decomposed into
   separately interpreted Effects.
5. Make `turn-repository.ts` re-export the exact existing surface and keep
   `packages/persistence/src/index.ts` and package exports unchanged.

Verification:

```sh
bun --bun vitest run --project unit packages/persistence/test
bun --cwd packages/persistence typecheck
```

## Step 3 — Extract pure TUI state and renderer planning

1. Extract `view-state/model.ts` first. Redirect transcript-presenter type
   imports from the `view-state.ts` facade to that model owner before moving
   any reducer code. Then split in dependency order: queue and layout selectors
   → composer parsing/editing → transcript transitions → navigation and
   top-level `update`. Create the facade last.
2. Preserve `ViewState`'s root namespace exports through `view-state.ts` and
   `packages/tui/src/index.ts`.
3. Extract adapter functions that produce strings, `StyledText`, descriptors,
   and row plans before moving any `Surface` lifecycle code.
4. Reuse existing transcript presenter and viewport modules. Do not create a
   second row/window/projection implementation.
5. Keep renderer-facing OpenTUI value imports in TUI renderer/adapter files;
   pure state and transcript projection modules must not gain OpenTUI imports.

Verification:

```sh
bun --bun vitest run --project unit packages/tui/test
bun --cwd packages/tui typecheck
```

## Step 4 — Extract the Relay execution backend

1. Move pure identity, route, model-selection, toolkit, execution event/status,
   child-result, fan-out, and workflow translations first.
2. Move `followExecution` and related recursive child discovery next.
3. Move `layerFromClient` into `relay/client-layer.ts`; it remains the owner of
   client readiness and the `ExecutionBackend.Service` implementation.
4. Move embedded SQLite/Relay/Baton registration and host handlers last.
   `embedded-layer.ts` depends on `client-layer.ts`, never the reverse, and is
   the only new module that imports `@relayfx/sdk/sqlite`. Thread-host
   registration remains owned by `client-layer.ts`.
5. Keep `execution-backend.ts` as the `@rika/runtime/relay` facade, including
   all current public helpers and streaming-only-model re-exports.

Do not merge the embedded `childResult` host handler with
`resolveChildResult`. Their failure/delta recovery is not currently proven
equivalent. Do not deduplicate workspace/credential resolution in this plan;
that would turn a move into a semantic review.

Verification:

```sh
bun --bun vitest run --project unit packages/runtime/test
bun --cwd packages/runtime typecheck
```

## Step 5 — Extract the app operation service

The main hazard is `productLayer`, whose nested functions capture acquired
services and mutable coordination state. Extract factories in this order:

1. Public options/auth and standalone reconciliation.
2. Execution-tree projection/replay/persistence and queue event mapping.
3. Prompt preparation, usage/title/summary, and review settlement.
4. Interactive feed delivery and selection buffering.
5. Interactive execution/following, queue promotion, history paging, and
   controls.
6. Command dispatch, reconcile scheduling, and `productLayer` composition.

Pass currently captured values through one narrow, operation-private parameter
object where needed. Do not turn it into an Effect service, public interface,
or reusable architecture. Preserve `ownerScope`, queue creation, fibers,
admission ordering, observers, and finalizers exactly.

Before extracting dispatch, retarget the type-only import in
`extension-operations.ts` from the `operation.ts` facade to the existing
`operation-contract.ts` owner.

`operation.ts` remains the compatibility facade for contract re-exports,
`ProductLayerOptions`, `runAuth`, `reconcile`, `rootExecutionEvents`,
`productLayer`, and `testLayer`. Avoid the existing type-only
`extension-operations.ts → operation.ts` edge becoming a runtime cycle.

Verification:

```sh
bun --bun vitest run --project unit packages/app/test
bun --cwd packages/app typecheck
```

## Step 6 — Extract resident transports

Treat the proposed resident tree as a maximum boundary map, not a requirement
to create every file. Extract only a bottom-up factory or pure policy with a
clean live closure boundary; prefer fewer cohesive files below 1,000 lines to
inventing state-carrier abstractions.

1. Keep `resident-wire.ts` as the direction-neutral schema/chunking boundary;
   client and host modules depend on it and never on each other.
2. Client: move close/reconnect policy, physical authenticated connection,
   request multiplexing, interactive event delivery, and start-or-attach
   acquisition separately. Preserve writer capacity, replay/ack sequence,
   retry eligibility, and mutation retry rules.
3. Host: move interactive feed sequencing/backpressure, owner request routing,
   authenticated connection/frame handling, and server/grace shutdown
   separately. Preserve frame limits, proof validation, admission, and grace
   timing.
4. Keep facade exports used by tests and fixtures (`residentSocketFailure`,
   `make`, and `serve`) available from their current files.

Verification:

```sh
bun --bun vitest run --project unit \
  apps/rika/test/resident-*.test.ts \
  apps/rika/test/resident-wire.test.ts
bun --cwd apps/rika typecheck
```

## Step 7 — Shrink `main.ts` to the process boundary

Repoint direct test imports before each extraction. In particular, update
prompt-parts, model-provider-runtime, test-model-script, shell-session, and
terminal-title tests to import the new owning module rather than `main.ts`.

Extract in this order:

1. Workspace/path/editor/changed-file and prompt attachment functions.
2. Test-model parsing and model route/pin/restoration functions.
3. Configured and lazy backend Layer factories.
4. TUI program and lifecycle policies.
5. Operation composition and resident owner.
6. Client dispatch and host program factories.

`main.ts` must finish with only its existing Path and environment
interpretations, parsed command dispatch, host-vs-client program choice,
observability/error wrapping, and `BunRuntime.runMain` branches.
`client-main.ts` and its separate `BunRuntime.runMain` entrypoint remain
untouched. Composition modules return Effects or Layers and never run them.
Preserve the direction
`operation composition → lazy backend → configured backend`, never reverse.

Explicitly verify that `--help`, `--version`, and malformed input stay on the
pre-initialization path.

Verification:

```sh
bun --bun vitest run --project unit \
  apps/rika/test/command.test.ts \
  apps/rika/test/prompt-parts.test.ts \
  apps/rika/test/model-provider-runtime.test.ts \
  apps/rika/test/test-model-script.test.ts \
  apps/rika/test/shell-session.test.ts \
  apps/rika/test/terminal-title.test.ts
bun --cwd apps/rika typecheck
```

## Step 8 — Extract the OpenTUI `Surface` last

With pure renderers already moved, reduce the lifecycle class without changing
its external contract or transferring mutable resource ownership:

1. Move renderable construction and mount wiring.
2. Move keyboard/mouse/focus event translation.
3. Extract pure transcript anchor/scroll/viewport plans, but keep their mutable
   execution in `Surface` and reuse the existing `transcript-viewport.ts`.
4. Extract pure reconcile/update plans and content construction, but keep
   renderable mutation and ordering in `Surface`.
5. Leave `surface.ts` owning event registration, fields, timers/fibers,
   mutable viewport and anchor state, resource lifetime, update sequencing,
   finalizers, disposal, and calls into the focused pure functions.

Do not change scrolling ownership, frame anchoring, culling, background
painting, cursor behavior, or timing while extracting. Plan 011 owns prior
viewport behavior decisions; this step preserves its current result.

Keep `adapter.ts` as the `@rika/tui/adapter` facade for all current constants,
render functions, classes, types, `Surface`, and `create`.

Verification:

If these pure extractions cannot bring `surface.ts` below 1,000 lines, stop and
replan rather than introducing a controller, delegate interface, or mutable
state carrier in this refactor.

```sh
bun --bun vitest run --project unit packages/tui/test
bun run test-scene
bun --cwd packages/tui typecheck
```

## Step 9 — Final structural and behavior verification

Inventory giant files:

```sh
rg --files -g '*.ts' \
  -g '!repos/**' -g '!node_modules/**' -g '!**/dist/**' -0 \
  | xargs -0 wc -l \
  | sort -nr \
  | head -40
```

Expected:

- no first-party TypeScript file remains over 1,000 lines; if one does, the
  plan is not complete and must stop for a cohesion/replan decision;
- facades are small and contain exports/composition, not copied
  implementations;
- every new production file over 500 lines has a written cohesion rationale;
- no new test file exceeds 500 lines without being an intentionally exhaustive
  real-adapter integration suite and receiving the same review rationale.

Check package manifests and framework boundaries:

```sh
bun run dependency-check
bun run effect-check
bun run pattern-check
```

These commands do not detect TypeScript import cycles. For every extracted
directory, run an explicit import-direction review: no child may import its
compatibility facade, and no adapter/presenter contract may point back to a
higher composition module. Record the reviewed edges in the change summary.

Then run the repository gate:

```sh
bun run check
```

Review the diff with rename detection. It should predominantly show moved
code, import changes, and facade exports. Any material branch, literal,
schedule, SQL, schema, error, or assertion change requires removal from this
refactor or a separately approved behavior-change commit.

## Test matrix

| Invariant                                                             | Level                            | Owner                          |
| --------------------------------------------------------------------- | -------------------------------- | ------------------------------ |
| Public package subpaths and exports compile unchanged                 | Typecheck/build                  | app, persistence, runtime, TUI |
| SQL queue operations retain atomicity and concurrency                 | Unit with real SQLite            | persistence                    |
| Execution mapping, follow, control, child, fan-out, workflow behavior | Unit + real Relay adapter tests  | runtime                        |
| Reconcile, projection, queue, session, dispatch behavior              | Unit                             | app                            |
| Reducer, presenter, Surface, scroll, input, animation behavior        | Unit + real OpenTUI tests        | TUI                            |
| Resident auth, replay, reconnect, backpressure, grace behavior        | Unit with real processes/sockets | CLI transport                  |
| Help/version/parse paths remain lazy                                  | Unit/packaged command tests      | CLI                            |
| User-visible interactive behavior remains unchanged                   | Scene                            | CLI/TUI/app stack              |
| Packaged CLI paths remain unchanged                                   | Journey via final `check`        | whole product                  |

## STOP conditions

- An extraction requires changing a public package export or wire/schema
  contract.
- A move requires changing a SQL transaction envelope, Effect scope/finalizer,
  queue capacity, schedule, fork ownership, or initialization order.
- `main.ts` can only be shrunk by initializing product services before command
  parsing.
- An extraction would relocate any current `BunRuntime.runMain`, the
  module-level Path `Effect.runSync`, or the environment `Effect.runSync`; the
  existing process-topology conflict needs a separate owner decision, not an
  opportunistic fix here.
- An extracted module must import its facade, producing a cycle.
- A test fails for behavior rather than an import/fixture relocation and the
  same failure is not reproducible at the baseline.
- Existing concurrent changes overlap an in-scope block and ownership cannot
  be preserved without overwriting them.

## Out of scope

- SOLID, clean-architecture, service, repository, strategy, or dependency
  inversion redesigns.
- Behavior fixes, performance work, type-boundary hardening, wire changes, SQL
  query changes, error redesign, and public API cleanup.
- Consolidating Relay child-result recovery or duplicated route/workspace
  logic.
- New file-size CI, Markdown validators, status ledgers, or architecture docs.
- Splitting files below the 1,000-line baseline solely to satisfy a line-count
  aesthetic.
