# Plan 017: Idiomatic standalone packaging and GitHub releases

> **Executor instructions**: Preserve Rika's public-client/private-runtime process boundary and all product behavior. Replace unsupported native-package staging with the released Bun/OpenTUI/FFF standalone contracts. Do not add npm publication, Windows, musl, an updater, or a one-binary process refactor.
>
> **Drift check (run first)**:
> `git diff -- scripts/package.ts scripts/release-smoke.ts scripts/local-install.ts apps/rika/package.json apps/rika/src/client-main.ts apps/rika/src/command.ts packages/tools/package.json packages/tools/src/workspace-index.ts .github/workflows/release-proof.yml test/scripts/package.test.ts`
>
> **Stop conditions**: Stop rather than weakening behavior if the published `@ff-labs/fff-bun` package cannot preserve Rika's file-search, glob, grep, watcher, symlink-containment, interruption, or cleanup behavior from a compiled executable without external files. Stop rather than claiming a target if its extracted archive cannot run the complete native smoke on that target.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: high
- **Category**: packaging + release engineering + simplification
- **Depends on**: none
- **Issue**: —

## Evidence and problem statement

Rika currently compiles `rika` and `.rika-runtime`, then reconstructs an executable-adjacent npm tree by probing Bun's internal package store, invoking `npm pack`, extracting registry archives, temporarily mutating `node_modules`, and copying OpenTUI, FFF, `ffi-rs`, and target-native files. Each target job also emits a partial `SHA256SUMS` and partial release-evidence file, while the workflow uploads temporary Actions artifacts rather than publishing a GitHub Release. The CLI version remains hard-coded to `0.0.0`.

Bun, OpenTUI, and `@ff-labs/fff-bun` support target-specific standalone executables with native assets imported as files. OpenCode uses this exact stack by installing native packages as build inputs, compiling explicit target/libc variants with `Bun.build`, and distributing target-specific artifacts. The idiomatic correction is a thin product build orchestrator, not removal of all TypeScript release logic.

## Non-negotiable invariants

1. `bin/rika` remains the small public client and `bin/.rika-runtime` remains the private runtime.
2. Help, version, parsing, and shell completion remain isolated from SQL, Relay, providers, tools, FFF, and OpenTUI startup.
3. Every extracted release archive runs without Bun, repository files, or external `node_modules`.
4. File search, glob, plain and regex grep, pagination, watcher refresh, ignored paths, symlink containment, interruption, and scope cleanup preserve behavior.
5. Every claimed target loads both FFF and OpenTUI native assets and completes a deterministic resident turn.
6. Semantic version, tag, source revision, archive name, checksum, and release evidence agree.
7. Producer jobs build each archive once; aggregation, attestation, and publication never rebuild it.
8. A targeted package command only replaces outputs it owns.
9. Existing features are not removed to reduce size.

## Target end state

```text
source + frozen lockfile
  -> target-native Bun.build client and runtime
  -> rika-<version>-<target>.tar.gz
  -> clean extraction and full native smoke
  -> per-archive build provenance
  -> exact-set aggregation
  -> SHA256SUMS + release-evidence.json
  -> draft GitHub Release
  -> publish only after every gate succeeds
```

Each archive contains only:

```text
rika-<version>-<target>/
  INSTALL
  bin/rika
  bin/.rika-runtime
```

## Implementation phases

### 1. Record the baseline and lock the FFF contract

- Build the host target with the current packager and record uncompressed executable sizes, archive size, file inventory, and smoke result.
- Add focused WorkspaceIndex behavior coverage for fuzzy search, glob, plain/regex grep, pagination, post-scan file creation, ignored paths, internal/external symlinks, and scope cleanup.
- Inspect and exact-pin the published `@ff-labs/fff-bun` package and matching native packages.
- Compile and run a host FFF probe from an empty directory with no external package tree.

### 2. Move WorkspaceIndex to Bun-native FFF

- Replace `@ff-labs/fff-node` with exact-pinned `@ff-labs/fff-bun` in `@rika/tools`.
- Remove the redundant CLI dependency and all `ffi-rs` packaging assumptions.
- Replace the executable-adjacent dynamic loader with the normal static `FileFinder` import while preserving the Effect service, typed errors, interruption, and scoped destruction.
- Run the Phase 1 characterization suite unchanged.

### 3. Reduce packaging to a thin Bun orchestrator

- Centralize supported product target metadata for the existing four glibc targets: Darwin arm64/x64 and Linux arm64/x64.
- Make the CLI package manifest the semantic-version source and inject it into both executables; keep build identity/source revision separate.
- Use checked `Bun.build()` calls for `client-main.ts` and `main.ts`, with target-specific `FFF_LIBC` and `process.env.OPENTUI_LIBC` definitions.
- Use released OpenTUI/FFF embedded asset paths. Remove package-store probing, `npm pack`, temporary dependency mutation, native copying, and staged `node_modules`.
- Audit externals and fail isolated-artifact tests for any undeclared runtime dependency.
- Require explicit `--target` packaging so accidental cross-builds cannot be mistaken for host-validated artifacts.
- Make a target build clean only its target output.
- Keep archive assembly minimal and deterministic only where the complete artifact can actually be reproducible.

### 4. Make package and smoke contracts executable

- Unit-test target metadata, ownership-safe cleanup, versioned names, exact artifact-set validation, evidence schema, unsupported targets, and client graph isolation.
- Extend release smoke to assert exact version and target and to reject archives containing `node_modules` or unexpected files.
- Exercise version, tools, FFF-backed grep, deterministic resident execution, persistence, and OpenTUI startup from the extracted archive.
- Measure before/after client, runtime, total extracted, and compressed sizes. Investigate source maps, minification, duplicated assets, dead code, and avoidable bundler autoloading without changing behavior.

### 5. Create authoritative GitHub publishing workflows

- Replace release proof with target-native producer jobs that install from the frozen lockfile, assert host identity, package one target, inspect architecture, extract, fully smoke, attest, and upload one unchanged archive.
- Remove the macOS x64 boot-only exception; use a genuine native runner or state a Rosetta limitation explicitly.
- Add an aggregator that downloads every archive, validates the exact target set, generates the sole checksums and release evidence, and creates a draft GitHub Release for a validated `v<version>` tag.
- Publish the draft only after all assets and metadata validate. Keep manual dispatch proof-only unless it receives and validates an existing tag.
- Give write, OIDC, and attestation permissions only to jobs that require them. Pin actions to immutable commit SHAs with version comments.
- Do not publish to npm.

### 6. Remove legacy code and align contracts

- Delete superseded package fetching, native staging, partial-manifest, and executable-adjacent dependency code and its tests.
- Update packaging/local-install documentation and correct the README claim that `install-local` packages the worktree.
- Keep local installation atomic and preserve state/configuration.
- Do not retain compatibility wrappers or dead aliases for the old artifact layout.

## Required verification

```sh
bun --bun vitest run --project unit packages/tools/test/tool-runtime-filesystem.proc.test.ts
bun --bun vitest run --project unit test/scripts/package.test.ts
bun run test
bun run package -- --target <host-target>
bun run release-smoke -- --target <host-target>
bun run check
```

Release CI additionally must run the extracted-archive smoke on every claimed target and verify the exact aggregate artifact set before publication.

## Completion criteria

- No packaging-time registry fetches or Bun package-store inspection.
- No release archive contains `node_modules`, `fff-node`, or `ffi-rs`.
- Both executables are standalone while preserving the client/runtime boundary.
- Exact semantic version is reported and agrees with the release tag and evidence.
- Every current target runs the full extracted-artifact native smoke.
- One validated tag creates one complete checksummed, attested GitHub Release and no npm publication.
- New focused tests, `bun run test`, host package/smoke, and `bun run check` pass.
- The final report includes baseline and resulting sizes and explains every material size change.
