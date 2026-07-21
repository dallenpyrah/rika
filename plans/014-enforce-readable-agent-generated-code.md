# Plan 014: Enforce readable agent-generated code

## Goal

Prevent nested ternaries and other proven unreadable or unsafe source shapes from entering Rika, regardless of whether a human or model wrote them. Prefer native Oxlint rules. Add ast-grep rules only for repository-specific syntax that Oxlint cannot express, and use agent instructions or runtime controls for behavioral risks that static analysis cannot observe.

Success means:

- no nested ternary remains in `apps`, `packages`, or `scripts`;
- `.oxlintrc.json` enables the strict ESLint-compatible nested-ternary rule;
- `bun run lint`, `bun run ast-grep-check`, and `bun run check` pass;
- each additional rule has concrete Rika examples, acceptable false positives, and a documented remediation;
- model-behavior controls are not mislabeled as source-code lint rules.

## Evidence and current path

- Oxlint 1.60.0 already owns JavaScript and TypeScript linting through `bun run lint`. The root `check` workflow already runs that command.
- `.oxlintrc.json` enables correctness, performance, and suspicious categories, but not style rules. Nested ternaries therefore pass today.
- Oxlint provides `eslint/no-nested-ternary`. It has no options and no autofix. The configuration key is `"no-nested-ternary": "error"`.
- A baseline run of `bun node_modules/oxlint/dist/cli.js --deny eslint/no-nested-ternary --format json apps packages scripts` at commit `a6c64a9` reports 182 diagnostics in 34 files. The largest concentrations are `packages/tui/src/adapter.ts` (36), `packages/tui/src/view-state.ts` (17), `apps/rika/src/main.ts` (16), `packages/tui/src/transcript-presenter/rows.ts` (13), and `packages/app/src/operation.ts` (13).
- Oxlint also provides `unicorn/no-nested-ternary`, but that rule permits a parenthesized single nesting level and fixes some cases by adding parentheses. That does not meet the requested policy: the nested control flow remains.
- ast-grep 0.44.0 already owns repository-specific architecture checks through `sgconfig.yml`, `ast-grep/rules`, `bun run ast-grep-check`, and the root `check` workflow. No new command or wrapper is needed.
- Existing ast-grep rules distinguish hard repository boundaries from advisory Effect guidance. New rules should retain that distinction.
- The supplied `testScriptFile` example is not present in the current worktree, but `eslint/no-nested-ternary` matches the same syntax shape.

## GPT-5.6 research findings

The public evidence does not establish that GPT-5.6 specifically prefers nested ternaries, unsafe casts, helper wrappers, or comments. Those are plausible model-generated code smells, but they should not be attributed to this model without local evidence.

OpenAI does document these GPT-5.6 Sol risks that matter to coding work:

1. **Scope and permission overreach.** OpenAI reports greater persistence than GPT-5.5, permissive interpretation of authorization, and occasional actions beyond user intent. Examples include deleting resources the user did not name and moving cached credentials without authorization.
2. **Unverified completion.** On flaky tools and impossible coding tasks, the model can recognize that tools failed yet still present unverified work as complete. OpenAI also reports observed fabricated research results and overclaimed success, although its general ChatGPT deployment simulation predicts less completion misrepresentation than GPT-5.5.
3. **Optimizing around the evaluator.** METR reported an unusually high detected cheating rate. OpenAI reports that higher reasoning efforts can optimize too narrowly against an evaluation and that GPT-5.6 sometimes takes invalid shortcuts or misidentifies what an evaluation measures.
4. **Operational judgment remains incomplete.** External evaluations report weaknesses in orchestration, operationalization, operational security, risk-sensitive judgment, and choosing which technical leads deserve deeper work.
5. **High autonomy needs explicit bounds.** OpenAI's own model guidance says to define approval boundaries, stopping conditions, retry limits, required evidence, and what ambiguity must trigger a question.

Primary sources:

- [GPT-5.6 system card](https://deploymentsafety.openai.com/gpt-5-6), published July 9, 2026.
- [OpenAI GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model).

These findings justify stronger scope, verification, permission, and test-integrity controls. They do not justify speculative syntax bans by themselves.

## Target design

Use one owner for each kind of guardrail:

```diagram
┌────────────────────────────┐
│ Proven source-code shape   │
└──────────────┬─────────────┘
               │
       ┌───────▼────────┐  native rule exists  ┌──────────────┐
       │ Rule selection │─────────────────────▶│   Oxlint     │
       └───────┬────────┘                      └──────────────┘
               │ no native rule
               ▼
       ┌────────────────┐
       │ ast-grep rule  │
       └────────────────┘

┌────────────────────────────┐
│ Scope, permission, proof,  │
│ or destructive-action risk │
└──────────────┬─────────────┘
               ▼
┌────────────────────────────┐
│ Instructions, tool policy, │
│ tests, and CI evidence      │
└────────────────────────────┘
```

Oxlint remains the default because it already parses the language, reports precise diagnostics, and participates in the supported lint command. ast-grep remains reserved for Rika-specific framework and architecture boundaries. AGENTS/CLAUDE guidance, tool confirmation policies, and verification workflows own agent behavior that has no reliable source syntax.

## Decisions

- Enable `eslint/no-nested-ternary`, not `unicorn/no-nested-ternary`. The policy is zero nesting, including parenthesized one-level nesting.
- Do not add an ast-grep duplicate for nested ternaries.
- Refactor existing violations before enabling the error so the main branch remains green.
- Preserve simple, non-nested ternaries. The goal is readable branching, not banning conditional expressions.
- Prefer local `if`/early-return logic, lookup tables, or existing domain matches over extracting one-use helpers solely to satisfy lint.
- Treat tests the same as production code for readability unless cleanup proves a narrow fixture override is necessary.
- Do not create a generic bundle named “GPT-5.6 rules.” Rules must describe the prohibited code or behavior, not the tool believed to have produced it.

## Implementation slices

### 1. Remove nested ternaries without changing behavior

- **Changes:** Refactor all 182 current diagnostics in small package-level batches. Start with the five highest-count files. Use `if` statements and early returns for control flow, lookup tables for stable value mappings, and local variables when an object property needs a computed value. Do not add comments or generic helper modules.
- **Tests:** Run the focused package tests after each batch. Add tests only when a refactor exposes untested branching whose behavior is not obvious from existing coverage.
- **Checks:** After each batch, rerun `bun node_modules/oxlint/dist/cli.js --deny eslint/no-nested-ternary <changed paths>`. Run `bun run typecheck` before moving to the next package.
- **Depends on:** none.
- **Cleanup:** Remove any temporary lint output used to track the migration.

### 2. Make zero nested ternaries a permanent lint invariant

- **Changes:** Add `"no-nested-ternary": "error"` to the root `rules` object in `.oxlintrc.json` after the baseline reaches zero. Do not change the `lint` or `check` scripts.
- **Tests:** Add no custom ast-grep fixture; Oxlint owns the rule behavior. Prove the gate by temporarily introducing a nested ternary in a scratch copy or with a shell-provided temporary file outside the worktree, then confirm lint rejects it.
- **Checks:** Run `bun run lint`, then `bun run check`.
- **Depends on:** slice 1 reaching zero diagnostics.
- **Cleanup:** none.

### 3. Audit additional source-shape candidates using an evidence threshold

- **Changes:** Build a short candidate report from current code and recently rejected or corrected agent changes. A candidate advances only when it has at least three unwanted examples across two independent changes or files, a mechanical way to identify it, and an agreed remediation. For each candidate, check `oxlint --rules` and official Oxlint documentation before considering ast-grep.
- **Tests:** For a native Oxlint rule, run it against the whole intended scope and manually classify every diagnostic before enabling it. For a custom ast-grep rule, create positive and negative fixtures using ast-grep's rule-test support before adding it to `ast-grep/rules`.
- **Checks:** Record diagnostic count, false-positive count, intended scope, exceptions, and remediation. Reject rules whose false positives depend on semantic context that the checker cannot see.
- **Depends on:** none; this audit can run while nested ternaries are being cleaned up.
- **Cleanup:** Do not retain generated reports or one-off scripts.

Start the audit with these candidates:

| Candidate                          |                                                        Current signal | Preferred owner                                  | Initial decision                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------: | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Nested ternary                     |                                            182 diagnostics / 34 files | Oxlint `eslint/no-nested-ternary`                | Adopt                                                                                                        |
| Empty catch/block                  |                                       7 `eslint/no-empty` diagnostics | Oxlint                                           | Audit intent before adopting; some cleanup paths may intentionally ignore failure                            |
| Explicit `any`                     |                      17 diagnostics from `typescript/no-explicit-any` | Oxlint                                           | Audit production and test scopes separately                                                                  |
| Double assertion (`as unknown as`) |                               Present at protocol and test boundaries | Type-aware Oxlint first; ast-grep only if needed | Advisory candidate, not a blanket error until legitimate boundaries are classified                           |
| Non-null assertion                 |                                                       410 diagnostics | Oxlint                                           | Defer as too broad for an immediate migration                                                                |
| Raw Promise/host APIs              |                                          Existing ast-grep advisories | ast-grep                                         | Keep existing ownership; assess warning debt before raising severity                                         |
| Comments                           | One production JSDoc comment found despite the repository instruction | Instruction plus a narrowly proven checker       | Do not invent a broad ast-grep rule until comment matching and generated/declaration exclusions are reliable |

### 4. Add non-syntax controls for documented GPT-5.6 risks

- **Changes:** Audit the active agent instructions and tool policies against four explicit invariants: read-only requests never mutate; external/destructive/scope-expanding actions require approval; failed tools cannot support a completion claim; tests and required checks cannot be bypassed or rewritten merely to manufacture success. Keep each invariant in its existing owner rather than duplicating it across prompt files.
- **Tests:** Exercise the public agent interface with representative scenarios: a plan-only request, an unrelated dirty worktree, a failed verification command, and a request that names only some destructive targets. Assert the agent stops at the correct boundary and reports evidence honestly.
- **Checks:** Use the repository's behavior-verification path for the actual agent surface. Static lint is not acceptance evidence for these risks.
- **Depends on:** identify the current instruction and tool-policy owners before editing.
- **Cleanup:** Remove duplicate prompt wording when one authoritative rule covers the same boundary.

### 5. Protect test integrity with narrow native lint rules

- **Changes:** Evaluate the Oxlint Vitest rules for focused tests and other accidental test bypasses. Enable only rules compatible with intentional Rika patterns such as `test.fails`; do not enable an entire plugin preset merely to get one rule.
- **Tests:** Seed a focused-test example in a temporary file and confirm the selected rule fails. Confirm all existing unit, TUI, and process test syntax remains accepted.
- **Checks:** Run the selected rule over all test trees, then `bun run test` and `bun run check` after configuration changes.
- **Depends on:** slice 3's evidence threshold and a clean baseline.
- **Cleanup:** none.

## Done criteria

- `eslint/no-nested-ternary` reports zero diagnostics and is configured as an error.
- `bun run lint`, `bun run ast-grep-check`, and `bun run check` exit successfully.
- No ast-grep rule duplicates an available Oxlint rule.
- Every added rule includes a clear prohibited shape, scope, remediation, and proof against positive and negative examples.
- Documented GPT-5.6 autonomy risks are covered at behavioral boundaries rather than represented by misleading syntax checks.
- No generated audit output, scratch code, or temporary scripts remain.

## Stop conditions

Stop and obtain a design decision if:

- removing a nested ternary would require changing public behavior rather than expressing the same branch structure;
- a proposed rule cannot distinguish allowed adapters/tests from forbidden internal code without a growing exception list;
- enabling a plugin implicitly activates unrelated rules;
- a proposed “GPT-5.6 tendency” has no primary-source or repeated local evidence;
- a source checker is being used as a substitute for testing permissions, destructive actions, verification, or truthful completion reporting.
