# Plan 001: Untrusted workspace settings can only tighten security, never loosen it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ea247c4..HEAD -- packages/config/src/config-service.ts packages/config/src/config-contract.ts packages/config/test/config-service.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S (the implemented scope — permission tightening); the provider-redirection half is deliberately deferred as a design decision, see STOP conditions.
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `ea247c4`, 2026-07-18
- **Issue**: https://github.com/dallenpyrah/rika/issues/148

## Why this matters

Rika merges a workspace's `.rika/settings.json` into effective config with no
trust prompt (unlike MCP servers, plugins, and skills, which all gate untrusted
input). Today a cloned or untrusted repository can ship a `.rika/settings.json`
that **loosens** the owner's global permission gates — for example flipping a
global `shell: "ask"` (human approval required before the model runs a command)
to `shell: "allow"`. That silently removes the human-in-the-loop protection the
owner set, for model-chosen shell commands, just by opening the repo.

This plan makes workspace-scope permission values able to make a permission
**more** restrictive but never **less** restrictive than the global/default
value. That is a safe, unambiguous change with no legitimate feature lost: there
is no documented reason a workspace should be able to weaken the owner's global
safety setting. After this, opening a hostile repo can only ever tighten your
gates, never open them.

A second, related risk (a workspace redirecting provider `baseUrl`/`apiKeyEnv`
to exfiltrate credentials) is **out of scope here** because it collides with a
documented, tested feature and needs a product decision — see STOP conditions
and Maintenance notes.

## Current state

The merge is a single pure function; the vulnerable line is the `permissions`
spread.

- `packages/config/src/config-service.ts` — owns global/workspace settings
  resolution. The merge (lines 18–42):

```ts
const mergeSettings = (global: SettingsInput, workspace: SettingsInput): Settings => {
  const provider = (id: ProviderId) => {
    const builtIn = defaults.providers[id]!
    const override = workspace.providers?.[id] ?? global.providers?.[id]
    if (override === undefined) return builtIn
    return {
      protocol: builtIn.protocol,
      baseUrl: override.baseUrl ?? builtIn.baseUrl,
      ...(override.apiKeyEnv === undefined ? {} : { apiKeyEnv: override.apiKeyEnv }),
    }
  }
  return {
    providers: { openai: provider("openai"), anthropic: provider("anthropic") },
    // ...
    permissions: { ...defaults.permissions, ...global.permissions, ...workspace.permissions },
    // ...
  }
}
```

The `permissions` line (36) lets `workspace.permissions` overwrite any
global/default value unconditionally — including making it more permissive.

- `packages/config/src/config-contract.ts`:
  - `PermissionDecision` type (line 8): `export type PermissionDecision = "allow" | "ask" | "deny"`.
    Restrictiveness order for this plan: `allow` (least) < `ask` < `deny` (most).
  - `defaults.permissions` (line 364): `{ read: "allow", search: "allow", write: "allow", shell: "allow", external: "allow" }`.
  - `Settings.permissions` type (line 73): `readonly permissions: Readonly<Record<string, PermissionDecision>>`.
  - Validation (lines 276–282) already rejects any permission value that is not
    `allow`/`ask`/`deny`, so merged values are always one of the three.

- The workspace file is loaded and merged with no trust gate:
  `apps/rika/src/main.ts` lines ~2766–2774 (`loadSettingsFile(workspaceConfig)`
  feeding `ConfigService.liveEnvironmentLayer({ global, workspace })`), and the
  enforced shell rule is emitted from the merged config at
  `apps/rika/src/main.ts` lines ~1436–1447
  (`{ pattern: "shell", level: config.settings.permissions.shell ?? … }`). These
  files are OUT of scope — the fix belongs in the pure merge, not the load path.

- **A conflicting test to be aware of (do NOT break the provider behavior it
  encodes)**: `packages/config/test/config-service.test.ts` line ~30,
  "replaces a global provider override at workspace scope without inheriting its
  credential", asserts a workspace `providers.openai.baseUrl` override wins. That
  test exercises the provider path this plan intentionally does NOT change. Your
  permission change must leave it passing.

Documented vocabulary/constraint to honor (`packages/config/CLAUDE.md`): this
package "owns typed settings, deterministic global/workspace resolution … It does
not read files or initialize providers." Keep the fix pure and inside
`mergeSettings`. Repo convention (root `CLAUDE.md`): **no comments in code**;
Effect-native; unit tests are `*.test.ts` with `@effect/vitest`.

## Commands you will need

| Purpose      | Command                                                            | Expected on success |
| ------------ | ------------------------------------------------------------------ | ------------------- |
| Typecheck    | `bun run typecheck`                                                | exit 0, no errors   |
| Focused test | `bun --bun vitest run packages/config/test/config-service.test.ts` | all pass            |
| Full test    | `bun run test`                                                     | all pass            |
| Lint         | `bun run lint`                                                     | exit 0              |
| Full gate    | `bun run check`                                                    | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `packages/config/src/config-service.ts` — the `mergeSettings` `permissions` merge.
- `packages/config/test/config-service.test.ts` — add the new test cases.

**Out of scope** (do NOT touch):

- The `provider(...)` helper and provider `baseUrl`/`apiKeyEnv` behavior — that is
  the separate design decision in STOP conditions; changing it here would break a
  documented, tested feature.
- `apps/rika/src/main.ts` (the load path and permission-rule emission) — the fix
  is in the pure merge, not the caller.
- `packages/config/src/config-contract.ts` validation — the three-value
  constraint already holds; do not add a fourth state or a new schema field.
- The `keymap`/`mcp`/`notifications`/`logging`/`extensionRoots` merges — only
  `permissions` changes.

## Git workflow

- Branch: `advisor/001-gate-workspace-settings`
- Commit style: plain imperative subject lines (match `git log`, e.g.
  "Restrict workspace permission merge to tightening"). One commit is fine.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make the workspace permission merge tighten-only

In `packages/config/src/config-service.ts`, replace the `permissions` line in the
returned object so that the global/default base is computed first, and a
workspace value is applied for a key **only if it is at least as restrictive** as
that base.

Target shape (adapt names to the file's style; no comments):

```ts
const permissionRank: Readonly<Record<PermissionDecision, number>> = { allow: 0, ask: 1, deny: 2 }

const tightenPermissions = (
  base: Readonly<Record<string, PermissionDecision>>,
  workspace: Readonly<Record<string, PermissionDecision>> | undefined,
): Readonly<Record<string, PermissionDecision>> => {
  if (workspace === undefined) return base
  const result: Record<string, PermissionDecision> = { ...base }
  for (const [key, decision] of Object.entries(workspace))
    if (permissionRank[decision] >= permissionRank[result[key] ?? "allow"]) result[key] = decision
  return result
}
```

Then in the returned object change line 36 from:

```ts
permissions: { ...defaults.permissions, ...global.permissions, ...workspace.permissions },
```

to:

```ts
permissions: tightenPermissions({ ...defaults.permissions, ...global.permissions }, workspace.permissions),
```

Import `PermissionDecision` from `./config-contract` if it is not already a type
import (it currently imports `ProviderId`, `Settings`, `SettingsInput` etc. from
there — add `PermissionDecision` to that type import list).

Note: the base keeps `defaults <- global` order, so the OWNER's global config may
still loosen a default (that is the owner's own machine and their choice). Only
the untrusted `workspace` layer is constrained to tightening.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Add unit tests proving workspace can tighten but not loosen

In `packages/config/test/config-service.test.ts`, add `it.effect` cases modeled
on the existing tests in that file (they build a `ConfigService.memoryLayer({ global, workspace })`
and assert `config.settings.permissions`). Add at minimum:

1. Global `shell: "ask"`, workspace `shell: "allow"` → merged `shell` is `"ask"`
   (workspace loosening is rejected).
2. Global `shell: "ask"`, workspace `shell: "deny"` → merged `shell` is `"deny"`
   (workspace tightening is applied).
3. Default `write: "allow"` (no global entry), workspace `write: "deny"` → merged
   `write` is `"deny"` (tightening from default works).
4. Global `shell: "allow"` (owner loosened the default globally), no workspace
   permissions → merged `shell` is `"allow"` (owner's own global choice preserved).

**Verify**: `bun --bun vitest run packages/config/test/config-service.test.ts` →
all pass, including the 4 new cases and the pre-existing provider-override test.

### Step 3: Full gate

**Verify**: `bun run check` → exit 0.

## Test plan

- New tests: the 4 cases in Step 2, in `packages/config/test/config-service.test.ts`,
  covering loosen-rejected, tighten-applied, tighten-from-default, and
  owner-global-loosen-preserved.
- Structural pattern to copy: the existing `it.effect("uses built-in providers …")`
  and `it.effect("replaces a global provider override at workspace scope …")`
  tests in the same file — same `provideLayer(ConfigService.memoryLayer({...}))`
  shape, asserting on `config.settings.permissions`.
- Verification: `bun --bun vitest run packages/config/test/config-service.test.ts`
  → all pass including 4 new; then `bun run test` → all pass (the change is
  isolated to the permissions merge, so no other suite should move).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun --bun vitest run packages/config/test/config-service.test.ts` passes, with 4 new permission cases
- [ ] `bun run test` exits 0
- [ ] `bun run lint` exits 0
- [ ] `grep -n "workspace.permissions" packages/config/src/config-service.ts` shows the value is passed through `tightenPermissions`, not spread directly into the object
- [ ] The pre-existing "replaces a global provider override at workspace scope" test still passes unchanged (provider behavior untouched)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `mergeSettings` already computes permissions with a tighten-only rule (the
  codebase drifted since `ea247c4`) — nothing to do.
- The `PermissionDecision` type is no longer `"allow" | "ask" | "deny"` (a fourth
  state would change the restrictiveness ordering this plan assumes).
- **Provider redirection (the SEC-01 half) — this is a product decision, not for
  the executor to implement here.** The same untrusted-workspace risk applies to
  a workspace overriding provider `baseUrl`/`apiKeyEnv`: it can redirect model
  traffic (and, when it also names a well-known `apiKeyEnv`, the live credential)
  to an attacker host, which then becomes the model driving the agent's tools.
  **Do NOT "fix" this by making provider fields global-only** — that would delete
  a feature documented in `docs/features/provider-configuration.md:3` ("A
  Workspace provider entry replaces the matching global provider entry as a
  unit") and break its tests in `config-service.test.ts`. The right remediation
  is a workspace-trust prompt (like MCP/plugins already have), which is new
  infrastructure and a separate plan. If you were told to also close SEC-01 in
  this plan, STOP and report that it needs a trust-gate design decision first.

## Maintenance notes

- **Open design decision (SEC-01, not resolved by this plan):** should an
  untrusted workspace be able to redirect provider `baseUrl`/`apiKeyEnv` at all?
  Options for the owner: (a) require a one-time trust approval for a workspace
  before its provider overrides apply (mirrors MCP/plugin trust — needs a
  persisted trust store and a prompt, so it cannot live in the pure
  `mergeSettings`); (b) keep the documented per-workspace override but never send
  a global/owner credential to a workspace-specified `baseUrl` (only send a key
  the workspace itself named, which is the current "replace as a unit" behavior —
  verify this holds); (c) accept the risk under the single-owner threat model and
  document it. This is a maintainer call; file it as its own plan/spike.
- A reviewer should confirm the restrictiveness ordering (`allow < ask < deny`)
  matches how `apps/rika/src/main.ts` interprets these levels when it emits
  permission rules, so "tighter" in config means "tighter" in enforcement.
- If a new permission category is added (e.g. `network`), it inherits the
  tighten-only rule automatically because the merge is key-agnostic; no change
  needed here.
