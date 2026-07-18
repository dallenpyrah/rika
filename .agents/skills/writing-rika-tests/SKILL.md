---
name: writing-rika-tests
description: "Use this skill when the user wants to add, repair, or reorganize Rika automated tests. Also use for regression coverage, test-first bug fixes, interactive TUI checks, and packaged CLI verification. Do not use only to list possible cases before implementation; use test-case-design instead. Use testing-with-pilotty or testing-with-agent-tty for manual TUI comparison and visual evidence."
---

# Writing Rika tests

Turn one promised behavior or known failure into the smallest Unit, Scene, or Journey test that proves it.

## Choose the test scope

Start at the interface people or callers use. Choose the lowest scope that can fail for the real reason:

| Scope   | Use when                                                                                                                    | File                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Unit    | One owner, rule, adapter, schema, state transition, or failure contract can prove the behavior                              | `*.test.ts` beside the matching path under `test/` |
| Scene   | A user-visible interactive behavior depends on the TUI and local runtime working together                                   | `*.scene.test.ts` using `apps/rika/test/scene.ts`  |
| Journey | The promise depends on the packaged executable, installation, signals, PTY process behavior, or state across real processes | `*.journey.test.ts` under `test/journey/`          |

Real SQLite, filesystem, process, Relay, or OpenTUI adapters do not by themselves make a test a Scene or Journey. Test scope follows the behavior being proved, not the runtime dependency.

Stress and live are profiles, not scopes. Name packaged stress coverage `*.stress.journey.test.ts` and keep real-time endurance cycles out of `bun run test`.

## Write the proof

1. State the public promise and the failure that would break it.
2. Read the owner, its supported interface, and nearby tests. Stop when the test seam and expected result are clear.
3. Write one failing check that reproduces the missing behavior. Prefer observable state, output, persisted data, or typed failure over private calls and mocks.
4. Run only that test and confirm it fails for the intended reason. A compile error, timeout, or unrelated setup failure is not a useful red state.
5. Implement the smallest correct behavior change when implementation is part of the request.
6. Run the focused test until green, then run the surrounding project. Use `bun run test` when the change can affect more than one scope.

For an existing bug, keep the regression test after the fix. For a refactor, preserve behavior first and do not weaken assertions merely to make the new structure pass.

## Unit rules

- Use `@effect/vitest` for Effect behavior.
- Use `TestClock` for time, retries, debounce, and scheduling when the promise does not depend on wall-clock or process timing.
- Prefer real in-memory or temporary adapters when their semantics are part of the rule.
- Assert typed failures and recovery paths, not only success.
- Keep source and test paths aligned with the existing package layout.

## Scene rules

- Keep the real TUI, controller, resident WebSocket transport, Relay, SQLite, tools, and process lifecycle.
- Script only the language model through `Scene.model`; provider models and network calls are forbidden.
- Use `Scene.action.writeAfter` or `checkRunningAfter` to wait for visible evidence instead of sleeping blindly.
- Wait for a unique completion marker or tool result. Composer echo is not proof that a turn completed.
- Assert the visible result and the important durable or diagnostic fact when both matter.
- Check diagnostics do not select a provider backend when model isolation is part of the test.

## Journey rules

- Use a Journey only when packaging or a real process boundary is part of the promise.
- Drive the supported CLI, PTY, files, signals, and reopen path. Do not import private production modules to manufacture the result.
- Isolate HOME, databases, workspace, ports, and process cleanup.
- Verify exit behavior and persisted results. Fail when child processes, leases, or open logs remain.
- Keep normal Journeys deterministic. Put load, repeated cycles, and long real-time waits in the stress profile.

## Check discovery

Before finishing, make sure Vitest owns the file exactly once:

```sh
bun --bun vitest list --project unit
bun --bun vitest list --project scene
bun --bun vitest list --project journey
```

Run the narrowest matching project while working. Then report what passed, what failed, what was not run, and what remains uncertain.

## Done when

- the test fails without the promised behavior and passes with it;
- its scope matches Unit, Scene, or Journey by behavior rather than machinery;
- no provider request or uncontrolled external state can affect deterministic checks;
- cleanup and important failure paths are covered; and
- Vitest discovers the file once in the intended project.
