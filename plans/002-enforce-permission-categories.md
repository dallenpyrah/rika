# Plan 002: Enforce all five tool-permission categories, not just `shell`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ea247c4..HEAD -- apps/rika/src/main.ts packages/tools/src/tool-catalog.ts packages/config/src/config-contract.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-\*.md (the workspace-config trust gate — it also edits `permissionPolicyForExecution` and the config permission merge; land 001 first to avoid a conflict)
- **Category**: security
- **Planned at**: commit `ea247c4`, 2026-07-18
- **Issue**: https://github.com/dallenpyrah/rika/issues/149

## Why this matters

Rika's config advertises five permission categories — `read`, `search`, `write`, `shell`, `external` — each settable to `allow`, `ask`, or `deny`, and `rika doctor`/`config list` display them. But only `shell` is ever enforced. An owner who sets `write: "ask"` to approve every model-driven file edit, or `external: "deny"` to block web fetches, gets **no enforcement**: file writes, web fetches, and reads all run regardless. The permission surface promises a safety control it does not deliver — the worst kind of security gap because the user believes they are protected. After this plan, all five categories are enforced through the same durable `permission_rules` mechanism that already works for `shell`.

## Current state

Three files, each with the exact code that must change:

- `apps/rika/src/main.ts` — `permissionPolicyForExecution` builds the permission policy handed to the durable agent. It emits only a wildcard-allow plus a single `shell` rule (lines 1439-1447):

  ```ts
  return {
    rules: [
      { pattern: "*", level: "allow" as const },
      {
        pattern: "shell",
        level: config.settings.permissions.shell ?? ConfigContract.defaults.permissions.shell!,
      },
    ],
  }
  ```

  The finer per-tool `toolNeedsApproval` hook is wired **only under a test env gate** (lines 1452-1454), so in production it never runs:

  ```ts
  ...(testApprovalTools._tag === "Some" && (testScript._tag === "Some" || testResponse._tag === "Some")
    ? { toolNeedsApproval: (name: string) => testApprovalTools.value.split(",").includes(name) }
    : {}),
  ```

  These `rules` are passed straight through to `client.registerAgent({ ..., permission_rules: permissionPolicy })` (`packages/runtime/src/execution-backend.ts:1517`). The mechanism you are extending is proven: a specific `pattern` (`"shell"`) already overrides the `"*"` wildcard, so adding more specific tool-name rules after the wildcard is the same, working pattern.

- `packages/tools/src/tool-catalog.ts` — every tool's `Definition` carries a `permission: "allow" | "ask"` field that is hardcoded `"allow"` for all 19 tools (lines 45-279), and a `presentation.family` of `explore | shell | edit | agent | direct | generic` (line 12). **`family` is a presentation concern and is not a usable permission category** — `explore` covers both `read_file` (a read) and `grep`/`find_files` (a search), which are _different_ categories. So the category must be assigned per tool, not derived from `family`. The catalog accessor is `get(name)` (line 292) and the array is exported as `definitions` (line 45).

- `packages/config/src/config-contract.ts` — the five categories and their default (line 364) and validation (lines 276-282):

  ```ts
  permissions: { read: "allow", search: "allow", write: "allow", shell: "allow", external: "allow" },
  ```

  ```ts
  if (value.permissions !== undefined) {
    const permissions = stringMap(path, "Permissions", value.permissions)
    if (
      Object.values(permissions).some((decision) => decision !== "allow" && decision !== "ask" && decision !== "deny")
    )
      throw ConfigFileError.make({ path, message: "Permission values must be allow, ask, or deny" })
  }
  ```

Repo conventions that apply here (from `CLAUDE.md`):

- **No code comments.** Do not add any.
- Effect-native: schemas via `effect` `Schema`, services/layers. `@rika/tools` "owns typed local coding-tool contracts, permission metadata" — adding a permission-category field to the catalog is squarely in its charter; OpenTUI/SQL/Relay/Baton stay out of that package.
- Test taxonomy: `*.test.ts` unit, `*.scene.test.ts` interactive with a scripted model. The permission surface already has `apps/rika/test/tool-permissions.scene.test.ts` and `apps/rika/test/permission-prompts.scene.test.ts` — model the new coverage on those.

## Commands you will need

| Purpose      | Command                       | Expected on success |
| ------------ | ----------------------------- | ------------------- |
| Typecheck    | `bun run typecheck`           | exit 0, no errors   |
| Focused test | `bun --bun vitest run <path>` | all pass            |
| Full gate    | `bun run check`               | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `packages/tools/src/tool-catalog.ts` — add the `category` field + values.
- `apps/rika/src/main.ts` — emit rules from all five categories.
- `apps/rika/test/tool-permissions.scene.test.ts` (extend) and/or a new `packages/tools/test/*.test.ts` for the category mapping.

**Out of scope** (do NOT touch):

- `packages/config/src/config-contract.ts` — the five categories and their validation already exist and are correct; do not change the schema.
- `packages/runtime/src/execution-backend.ts` — the `permission_rules` plumbing already works; only the _content_ of the rules changes, upstream in `main.ts`.
- `repos/*` (Baton/Relay) — never read, import, or edit. If you need to know how a `permission_rules` `level: "deny"` behaves and cannot confirm it from the public `@relayfx/sdk`/`@batonfx/core` types, that is a STOP condition, not a reason to open `repos/*`.

## Git workflow

- Branch: `advisor/002-enforce-permission-categories`
- Commit per step; plain imperative messages (e.g. "add permission category to tool catalog").
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a per-tool `category` to the tool catalog

In `packages/tools/src/tool-catalog.ts`, add a `Category` literal and a required `category` field on `Definition`:

```ts
export const Category = Schema.Literals(["read", "search", "write", "shell", "external"])
export type Category = typeof Category.Type
```

Add `category: Category` to the `Definition` struct (after `permission`). Then set `category` on every entry in `definitions`, per tool (NOT from `family`), using this table — the read/search/write/shell/external split matches what each tool actually does:

| tool                   | category   |
| ---------------------- | ---------- |
| `find_files`           | `search`   |
| `grep`                 | `search`   |
| `find_thread`          | `search`   |
| `read_file`            | `read`     |
| `view_media`           | `read`     |
| `read_thread`          | `read`     |
| `git_status`           | `read`     |
| `shell_command_status` | `read`     |
| `create_file`          | `write`    |
| `edit_file`            | `write`    |
| `apply_patch`          | `write`    |
| `shell`                | `shell`    |
| `web_search`           | `external` |
| `read_web_page`        | `external` |

The agent-spawning tools — `oracle`, `librarian`, `review`, `task`, `painter` — are **not** direct filesystem/network actions; their child executions carry their own permission policy. Assign them `category: "read"` **only if** every tool must have a category to satisfy the schema AND a `read`-level gate on them does not break the agent tests; otherwise see STOP conditions. Do not invent a sixth category.

**Verify**: `bun run typecheck` → exit 0 (the strict `Schema.Struct` forces you to give every definition a `category`; a missing one fails typecheck, which is the safety net).

### Step 2: Emit rules from all five categories in `permissionPolicyForExecution`

In `apps/rika/src/main.ts`, replace the two-element `rules` array (lines 1440-1446) with the wildcard base plus one specific rule per categorized tool, reading each tool's category level from config. This reuses the exact mechanism the `shell` rule already relies on (specific pattern overrides `*`):

```ts
return {
  rules: [
    { pattern: "*", level: "allow" as const },
    ...ToolCatalog.definitions.map((definition) => ({
      pattern: definition.name,
      level:
        config.settings.permissions[definition.category] ?? ConfigContract.defaults.permissions[definition.category]!,
    })),
  ],
}
```

Confirm `ToolCatalog` is already imported in `main.ts` (it is used elsewhere); if the import is `ToolCatalog.get` only, import `definitions` through the same namespace. Leave the test-only `toolNeedsApproval` gate (lines 1452-1454) untouched — the `permission_rules` channel now carries allow/ask/deny for real tools, and the test hook stays for the scripted-approval tests.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Prove enforcement with a scene test

Extend `apps/rika/test/tool-permissions.scene.test.ts` (read it first for the scripted-model + config-injection pattern) with cases that set a non-`allow` category and assert the effect:

- `write: "ask"` → a scripted model that calls `edit_file`/`create_file`/`apply_patch` produces an approval prompt (not silent execution).
- `external: "deny"` → a scripted model that calls `web_search`/`read_web_page` is denied.
- Regression: `shell: "ask"` still prompts (unchanged behavior).

**Verify**: `bun --bun vitest run apps/rika/test/tool-permissions.scene.test.ts` → all pass, including the new cases.

### Step 4: Full gate

**Verify**: `bun run check` → exit 0.

## Test plan

- New scene cases in `apps/rika/test/tool-permissions.scene.test.ts`: `write:"ask"` prompts on a write tool; `external:"deny"` blocks a web tool; `read:"ask"` prompts on `read_file`; `shell` behavior unchanged. Model after the existing cases in that file and `permission-prompts.scene.test.ts`.
- Optional narrower unit test in `packages/tools/test/`: assert `ToolCatalog.get("apply_patch")?.category === "write"` etc. for the full table, so a future catalog edit that drops a category is caught fast.
- Verification: the commands in each step, then `bun run check`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0.
- [ ] Every entry in `packages/tools/src/tool-catalog.ts` `definitions` has a `category`; `grep -c 'category:' packages/tools/src/tool-catalog.ts` ≥ 19.
- [ ] `apps/rika/src/main.ts` `permissionPolicyForExecution` no longer hardcodes only `shell`; `grep -n 'pattern: "shell"' apps/rika/src/main.ts` returns nothing (the shell rule is now produced by the mapped loop, not a literal).
- [ ] `bun --bun vitest run apps/rika/test/tool-permissions.scene.test.ts` passes with the new `write`/`external` cases.
- [ ] `bun run check` exits 0.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The code at lines 1439-1447 of `apps/rika/src/main.ts` or the catalog `definitions` no longer matches the "Current state" excerpts (drift since planning).
- Assigning a category to an agent-spawning tool (`oracle`/`librarian`/`review`/`task`/`painter`) makes an existing agent/subagent scene test (`apps/rika/test/parallel-subagents.scene.test.ts`, `child-runs.scene.test.ts`) prompt or deny where it should not — this means those tools need to stay wildcard-`allow`; report the conflict and the mapping question rather than forcing a category.
- A `permission_rules` `level: "deny"` does not actually block a tool at runtime (the scene test for `external:"deny"` still executes the tool), and you cannot confirm the deny semantics from the public `@relayfx/sdk`/`@batonfx/core` types — report it; do not open `repos/*`.
- Any step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **For the reviewer**: scrutinize the per-tool category table in Step 1 — it encodes a security policy. Confirm `write` covers exactly the mutating tools and `external` exactly the network tools; a miscategorization silently under- or over-enforces.
- Any new tool added to the catalog now MUST declare a `category` (the strict schema enforces this at typecheck) — this is the mechanism that keeps the surface honest, replacing the previous state where new tools defaulted to unenforced `allow`.
- **Smaller-scope fallback (only if Step 2's rule-emission proves unworkable)**: instead of enforcing the four categories, delete `read`/`search`/`write`/`external` from the config schema and the `doctor`/`config list` display so the surface honestly shows only `shell` is enforced. This is NOT recommended — it removes a control the owner may want — but it is the correct alternative to leaving a fake control in place. Do this only after reporting via a STOP condition, not on your own initiative.
- Interacts with plan 001: 001 gates whether a _workspace_ config may loosen these categories at all. Enforcement (this plan) and trust-gating (001) are complementary; both must hold for the permission model to be sound.
