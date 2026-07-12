# Local Release Evidence

Date: 2026-07-10

This record covers local packaging and verification only. No package or archive was published, no release was created, and Rika was not installed into the user's normal home or `PATH`.

## Archives

`bun run package:build` constructed these four archives:

- `rika-darwin-arm64.tar.gz`
- `rika-darwin-x64.tar.gz`
- `rika-linux-arm64.tar.gz`
- `rika-linux-x64.tar.gz`

All four entries in `artifacts/SHA256SUMS` passed `shasum -a 256 -c`. Each archive contains one target executable, its matching OpenTUI native package, and installation instructions. Archive metadata is normalized, but byte-for-byte compiler reproducibility is not claimed. Only the macOS arm64 executable could be run on this host; runtime proof for the other three targets remains assigned to the native-host release-proof CI matrix.

Windows is unsupported, rather than unchecked. OpenTUI runtime proof is absent for Windows, `scripts/package.ts --target win32-x64` rejects the target with `Windows archives are not supported`, and the construction test prevents Windows from being advertised.

## Installed Artifact and Product Flows

The macOS arm64 archive was extracted into a temporary installation root and run with isolated temporary `HOME`, product SQLite, Relay SQLite, and fixture workspace paths. The harness removed the root after completion. It proved help, version, migrations and reopen, tool catalog, thread creation/listing, link absence, excluded archive inventory, and SIGTERM teardown.

`bun run test:e2e` ran the extracted artifact, not workspace source, and passed 13 tests. The fixture coding flow used Baton's real `TestModel` integration through `RIKA_TEST_MODEL_RESPONSE`, completed two turns against a temporary fixture repository, emitted JSONL execution events, and persisted completed turn cursors. Packaged process checks covered SIGINT teardown and process-by-process persistence/reopen. The available Relay runtime process-death checks also cover cancellation, idempotent start, and cursor replay; kill/restart at every child-run and workflow boundary remains unproven.

Native OpenTUI tests passed keyboard input, palette, resize, streaming projection, queue updates, interruption routing, teardown, frozen character frames, and deterministic screenshot baselines. This is native renderer proof on macOS arm64, not Windows proof.

The extracted macOS arm64 package also passed a native PTY process test. The capture contained the welcome, composer submission, and alternate-screen, hidden-cursor, bracketed-paste, and mouse-mode activation sequences. A real `SIGINT` terminated the packaged process within the timeout, and the PTY termios state after exit exactly matched its pre-launch state. This test does not claim terminal-emulator pixel parity or native-host proof for other targets.

## Absence Scan

Archive inventory and packaged-flow checks found no symlinks, vendored Baton or Relay `node_modules`, Rivet, PostgreSQL, Docker socket, Windows OpenTUI native package, semantic-search feature, or ast-grep-outline feature. Source dependency checks remain the authoritative repository boundary gate.

## Verification Commands

- `bun run package:build` — pass, four archives
- `shasum -a 256 -c artifacts/SHA256SUMS` — pass, four archives
- `bun run package:construct:test` — pass, 2 tests
- `bun run scripts/package-smoke.ts` — pass
- `bun run test:e2e` — pass, 13 tests
- `bun test test/e2e/tui-pty.native.test.ts` — pass, 1 native PTY packaged-process test
- `bun test packages/runtime/test/execution-backend.native.test.ts` — pass, 7 tests
- `bun test packages/tui/test/*.native.test.ts` — pass, 5 tests
- `bun run docs:check` — pass
- `bun run format:check` — pass
- `bun run package:smoke` — pass

## Residual Risks

- The macOS x64 and both Linux executables were constructed and inspected locally but cannot be executed on this macOS arm64 host. Native-host CI evidence is required before release.
- Windows is explicitly unsupported until OpenTUI has native runtime and visual proof there.
- Published Relay `0.0.50` still has the documented undeclared MySQL import blocker. Publication and final registry-only dependency proof are outside this local evidence pass.
- Child-run and workflow kill/restart injection at every durable boundary, duplicate-visible-side-effect proof, complete deterministic model scenarios, live-model evaluation, the coverage target, and final oracle reviews remain open.
- The archives have per-build checksums and normalized archive metadata; reproducible compiler output is not claimed.
