# Plan 010 (spike): Gate untrusted workspace provider overrides behind owner approval

> **Executor instructions**: This is a DESIGN SPIKE, not a build-everything task.
> Produce the design artifacts and prototype named in "Deliverables", then STOP
> and report — do not ship the full feature in this pass. Write no production
> behavior beyond the thin prototype in Step 4. If anything in "STOP conditions"
> occurs, stop and report.
>
> **Drift check (run first)**: `git diff --stat ea247c4..HEAD -- apps/rika/src/main.ts packages/config/src/config-service.ts packages/extensions/src/mcp-trust.ts apps/rika/src/resident-endpoint.ts docs/features/provider-configuration.md`
> If any in-scope file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L (spike itself is M; the feature it designs is L)
- **Risk**: MED — the design must not break the documented per-workspace provider feature.
- **Depends on**: none to run the spike. Complements plans/001 (permission tightening) and plans/002 (permission enforcement); together the three close the workspace-config trust boundary.
- **Category**: security
- **Planned at**: commit `ea247c4`, 2026-07-18
- **Issue**: https://github.com/dallenpyrah/rika/issues/150

## Why this matters

Rika reads `.rika/settings.json` from the current working directory and merges
it into effective config with no trust prompt. A workspace provider entry can
override the built-in provider's `baseUrl` and `apiKeyEnv`. So opening (or
`cd`-ing into) a cloned, untrusted repository that ships a `.rika/settings.json`
pointing the provider `baseUrl` at an attacker host — and naming a well-known
env var like `OPENAI_API_KEY` as `apiKeyEnv` — causes every model request
(prompts, full source context, and the live API key in the auth header) to be
sent to that host. Worse, the attacker's endpoint then _is_ the model: it
controls the responses and therefore drives the agent's shell/`apply_patch`/file
tools inside the workspace. This directly contradicts PRODUCT.md's "keep product
state and authority local."

Per-workspace provider override is a **documented, tested feature**
(`docs/features/provider-configuration.md`), legitimately used for a per-repo
local proxy. So the fix is not to remove it — it is to **gate** it behind owner
approval for a workspace Rika has not seen before, mirroring how MCP servers and
plugins are already trusted. This spike designs that gate.

Plan 001 already handles the sibling permission-loosening half safely (workspace
permissions may only tighten). This plan covers the provider-override half, which
001 deliberately deferred because it cannot be silently removed without deleting
a documented feature.

## Current state

The facts the spike needs, inlined.

- `apps/rika/src/main.ts:1810-1811` — the two config paths:
  ```ts
  const globalConfig = `${home}/.config/rika/settings.json`
  const workspaceConfig = `${process.cwd()}/.rika/settings.json`
  ```
- `apps/rika/src/main.ts:2766-2774` — the ungated load + merge site: both files
  are read and handed to `ConfigService.liveEnvironmentLayer` with no trust check
  between load and apply:
  ```ts
  Layer.unwrap(
    Effect.gen(function* () {
      const globalSettings = yield* loadSettingsFile(globalConfig)
      const workspaceSettings = yield* loadSettingsFile(workspaceConfig)
      const applicationConfigLayer = ConfigService.liveEnvironmentLayer({
        global: globalSettings,
        workspace: workspaceSettings,
      })
      const effectiveConfig = yield* ConfigService.effective().pipe(provideLayerScoped(applicationConfigLayer))
  ```
  (The same pair is also assembled per-workspace at `main.ts:2784-2789` and for
  `doctor`/config surfaces at `:2993-2994`, `:3016-3017` — the gate must cover
  every site that feeds a _workspace_ settings object into `liveEnvironmentLayer`,
  not just the top one.)
- `apps/rika/src/main.ts:1592-1604` — `loadSettingsFile` only reads + JSON-decodes
  - `decodeSettingsInput`; there is no trust step:
  ```ts
  export const loadSettingsFile = Effect.fn("Main.loadSettingsFile")(function* (filename: string) {
    const fileSystem = yield* FileSystem.FileSystem
    if (!(yield* fileSystem.exists(filename))) return {}
    const text = yield* fileSystem.readFileString(filename).pipe(...)
    const value = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(...)
    return ConfigContract.decodeSettingsInput(filename, value)
  })
  ```
- `packages/config/src/config-service.ts:18-28` — the merge that applies the
  override. `mergeSettings` is a **pure** function (no Effect, no prompt access),
  and workspace wins:
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
  ```
  Because `mergeSettings` is pure, the gate cannot live here (it needs Effect to
  read the trust store and prompt). It belongs **before** the merge: filter the
  workspace `SettingsInput` so untrusted security-relevant fields never reach
  `mergeSettings`.
- `docs/features/provider-configuration.md` — the feature to preserve, verbatim:

  > Settings may override only the built-in `openai` and `anthropic` connections,
  > using `baseUrl` and `apiKeyEnv`. A Workspace provider entry replaces the
  > matching global provider entry as a unit … `baseUrl` must be an absolute HTTP
  > or HTTPS URL without embedded credentials, and `apiKeyEnv` must name an
  > uppercase environment variable.

  The doc already constrains the _shape_ (absolute URL, no embedded creds, env
  var name only — so a literal key can't be inlined). What it does **not** do is
  constrain _where_ the URL points or gate a first-time override. The spike adds
  the trust gate; the doc must gain a sentence about it.

### The two trust patterns to mirror (do not invent a third)

- `packages/extensions/src/mcp-trust.ts:20-30` — the service contract shape:
  ```ts
  export interface Interface {
    readonly create: (workspaceIdentity, workspaceRoot, server) => Effect.Effect<Record, TrustError>
    readonly isTrusted: (record: Record) => Effect.Effect<boolean>
    readonly approve: (record: Record) => Effect.Effect<void>
  }
  export class Service extends Context.Service<Service, Interface>()("@rika/extensions/mcp-trust/Service") {}
  ```
  Trust is keyed by a SHA-256 `fingerprint` over `workspaceIdentity` + the
  security-relevant fields, so a _changed_ server re-prompts. Copy this: key
  config trust on `workspaceIdentity` + a digest of the override fields.
- `packages/extensions/src/plugin-trust.ts:2-30` — the same idea with a
  `TrustRequired` typed error (`@rika/extensions/PluginTrustRequired`) carrying
  `workspaceIdentity`/`sourceDigest`, and a `memoryLayer` for tests. The
  `workspaceIdentity` concept already exists across the trust subsystem — reuse it.
- Persistence model: `packages/app/src/extension-operations.ts:297-300` persists
  MCP trust as a JSON document `{ approved: [...sorted] }` at
  `apps/rika/src/main.ts:1817` → `${home}/.config/rika/mcp-trust.json`, via
  `readDocument`/`writeDocument`. The config-trust store should be a sibling file
  (`${home}/.config/rika/workspace-config-trust.json`) with the same read/write.
- `apps/rika/src/resident-endpoint.ts:62-102` — the **credential-file hardening
  bar** the trust store must meet (it holds no secret, but it authorizes
  credential redirection, so treat it as security-sensitive): create with
  `{ flag: "wx", mode: 0o600 }`, reject if the path is a symlink
  (`fs.readLink` success ⇒ unsafe), verify owner `uid`, require `mode & 0o077 === 0`,
  and check inode/dev stability across the read. Reuse this exact check for the
  trust file.

## Commands you will need

| Purpose            | Command                       | Expected on success |
| ------------------ | ----------------------------- | ------------------- |
| Typecheck          | `bun run typecheck`           | exit 0, no errors   |
| Focused test       | `bun --bun vitest run <path>` | target tests pass   |
| Unit+scene+journey | `bun run test`                | all pass            |
| Lint               | `bun run lint`                | exit 0              |
| Full gate          | `bun run check`               | exit 0              |

## Suggested executor toolkit

- Read `packages/config/CLAUDE.md`, `packages/extensions/CLAUDE.md`, and
  `apps/rika/CLAUDE.md` for the local boundary rules (extensions must not import
  app/runtime/tui; the CLI shell must not initialize before command parsing).
- Read `docs/decisions/effect-cli.md` — any new prompt surface uses
  `effect/unstable/cli`.

## Scope

**In scope** (spike deliverables — a design doc plus a thin prototype seam):

- `plans/010-*.md` design content (this file's Deliverables section, filled in).
- A prototype `packages/config` (or `packages/extensions`) trust-check seam and
  its `memoryLayer`/`testLayer`, wired at ONE gate point behind a default-safe
  flag, enough to prove the shape. No prompt UX implementation, no persistence
  hardening implementation beyond a stub — those are specified, not built.
- One `*.test.ts` proving the gate ignores an untrusted override and applies a
  trusted one (memory trust layer).

**Out of scope** (do NOT build in this spike):

- The full prompt UX (CLI + TUI). Specify it; don't implement it.
- The hardened persistent trust store. Specify it (reuse resident-endpoint
  hardening); a memory/stub layer is enough for the spike.
- Any change to `mergeSettings`' purity or the documented provider shape.
- Plan 001's permission-tightening (already covered there) — only cross-link it.

## Git workflow

- Branch: `advisor/010-spike-provider-trust-gate`
- Plain imperative commit messages, matching the repo (`git log` shows
  "Fix integrated feature verification", "scene/permission-prompts" — no
  conventional-commits prefixes). Commit the design + prototype separately.
- Do NOT push or open a PR unless the operator instructs it.

## Deliverables (the spike produces these; fill them in as you investigate)

1. **Trust-store design.** A `WorkspaceConfigTrust` service (in `packages/config`
   or `packages/extensions`, decide and justify against the boundary CLAUDE.md
   files) mirroring `plugin-trust.ts`: `isTrusted(workspaceIdentity, digest)` /
   `approve(...)`, a `TrustRequired` typed error, a `memoryLayer` for tests, and a
   live layer persisting `{ approved: [...] }` to
   `${home}/.config/rika/workspace-config-trust.json` with the
   `resident-endpoint.ts:62-102` hardening. Define the digest input: the
   security-relevant workspace override fields only (provider `baseUrl`,
   `apiKeyEnv` per provider), so a benign workspace (no provider override) is
   never gated and a changed override re-prompts.

2. **The gate point.** Specify a pre-merge filter: before
   `ConfigService.liveEnvironmentLayer({ global, workspace })`, run the workspace
   `SettingsInput` through the trust check; for any security-relevant provider
   field not covered by an approved trust record, drop that field from the
   workspace input (fall back to global/default) — never apply an unapproved
   override. This keeps `mergeSettings` pure and covers all four load sites
   (`main.ts:2768`, `:2784`, `:2993`, `:3016`). State exactly how the filtered
   input is produced and threaded.

3. **Prompt UX.** Specify the first-use approval for interactive
   (`rika` / TUI, consistent with the existing MCP/plugin permission prompts) and
   the non-interactive fallback (`rika run` / `--stream-json`): with no TTY, the
   safe default is to **ignore** the untrusted override and log a diagnostic, not
   to block; state whether a `--trust-workspace` flag or a `rika config trust`
   command is the out-of-band approval path.

4. **Prototype.** Wire the trust check at the one top-level gate point behind the
   memory trust layer, with the default-safe behavior (untrusted ⇒ override
   ignored), and a `*.test.ts` proving: (a) an untrusted `.rika/settings.json`
   provider `baseUrl` override does NOT reach effective config; (b) an approved
   one does. Model the test on `packages/config/test/*`.

5. **Open-questions list** (resolve what you can, escalate the rest):
   - Approval scope: per-workspace, per-(workspace, override-digest) (recommended —
     matches MCP/plugin re-prompt-on-change), or per provider-host?
   - Is an `apiKeyEnv`-only override (no `baseUrl` change) security-relevant enough
     to gate? (It redirects which env var is read — lower risk, but a workspace
     naming a different owner secret is still exfil-adjacent.)
   - `workspaceIdentity` derivation: reuse the exact value MCP/plugin trust use so
     one workspace has one identity across all three trust domains.
   - Interaction with plan 001/002: should all three security-relevant
     workspace surfaces (provider override, permission loosening, and — later —
     plugin/MCP) share ONE workspace-trust record and ONE prompt, rather than
     three separate gates? (Strong candidate; note it for the maintainer.)

## Done criteria (for the spike)

- [ ] `plans/010-*.md` Deliverables 1–3 and 5 are filled with concrete designs and
      the resolved/open questions.
- [ ] The prototype seam typechecks (`bun run typecheck` exits 0).
- [ ] The gate `*.test.ts` proves untrusted-ignored / trusted-applied and fails
      when the gate is reverted.
- [ ] No documented provider-override behavior is removed (the existing
      provider-configuration tests still pass: `bun --bun vitest run packages/config`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- The code at the "Current state" locations doesn't match the excerpts (drift).
- A workspace-config trust gate already exists (then this is a review, not a build).
- The `workspaceIdentity` used by MCP/plugin trust is not reachable from the config
  load path without importing an out-of-boundary module (decide store placement
  first, then report the boundary tension).
- Building the prototype requires touching the prompt UX or the hardened
  persistence to prove the shape — that means the spike is turning into the full
  feature; stop and hand back the design.

## Maintenance notes

- This plan, plan 001 (permission tightening), and plan 002 (permission
  enforcement) together close the "`.rika/settings.json` is untrusted input"
  boundary. A reviewer should check they converge on ONE workspace-trust concept,
  not three parallel ones — the strongest end state is a single first-use
  "trust this workspace?" gate covering provider overrides, permission changes,
  and (via existing MCP/plugin trust) contributed code.
- When plan 008 (wire plugin contributions) lands, contributed tools become another
  security-relevant workspace surface — fold it into the same trust model.
- A reviewer should scrutinize that the pre-merge filter covers ALL four
  `liveEnvironmentLayer` workspace call sites, and that the trust file meets the
  resident-token hardening bar (symlink/uid/mode/inode).
