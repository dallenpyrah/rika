# Rika

Rika is a local-only durable coding-agent CLI and OpenTUI application built with Effect v4, Effect SQL, Baton, Relay, and OpenTUI.

The implementation is in its specification and dependency-proof phase. See `PLAN.md`, `TODO.md`, and `docs/features/FEATURES.md` for the execution plan and complete feature ledger.

## Boundaries

- Released Baton and Relay packages are the committed dependency contract; local coordinated development uses an explicit non-persistent link overlay, never copied source.

## Local Framework Development

Use sibling checkouts at `../batonfx` and `../relay` while developing framework and Rika changes together:

```bash
bun run upstream:link
bun run upstream:status
```

`upstream:link` builds Relay's public SDK, registers the required public Baton and Relay packages with Bun, links them into Rika without modifying `package.json` or `bun.lock`, and clears Turbo's local cache. Run it again after changing Relay build output.

Restore the pinned registry dependencies before final package verification:

```bash
bun run upstream:registry
```

- Relay owns durable executions and Child Runs.
- Baton owns the agent loop.
- Rika owns local product semantics, tools, extensions, persistence, and TUI behavior.
- Rika does not include Rivet, web, IDE, remote runners, orbs, semantic code search, or ast-grep outline.

## Commands

```bash
bun install
bun run docs:check
bun run deps:check
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

## Local installation

Keep `rika` as the last promoted local build. This command packages the current working tree for the current host
before installing it, so it cannot silently reinstall a stale executable:

```bash
bun run install:local
rika --version
```

`bun run install:local:existing` installs the existing host archive without rebuilding it. Use that only when you
intentionally want the previously packaged artifact. `bun run package:build` remains available when release work
needs archives for every supported platform.

For recoverable local promotions, commit the working tree and optionally create a local tag before installation:

```bash
git tag local/2026-07-12-description
bun run install:local
```

Git tags point to commits and do not include uncommitted changes.

The defaults are `~/.local/share/rika/current` for the packaged tree and `~/.local/bin/rika` for the command.
Set `RIKA_INSTALL_ROOT` and `RIKA_BIN_DIR` to override them. The installer keeps OpenTUI's native `node_modules`
adjacent to the packaged binary and refuses to replace a command it does not own. Remove only the installed program
and symlink with `bun run uninstall:local`; Rika state and configuration are retained.

If `~/.local/bin` is not already on your shell path, add it once:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Vibe proxy configuration

Rika follows Amp's settings layout. Global settings live at `~/.config/rika/settings.json`; a repository may override
them with `.rika/settings.json`. To route the default medium mode through an OpenAI-compatible Vibe proxy, use:

```json
{
  "providers": {
    "vibe": { "baseUrl": "http://127.0.0.1:8317/v1" }
  },
  "models": {
    "vibe-subscription": { "provider": "vibe", "model": "your-vibe-model-id" }
  },
  "modes": {
    "medium": { "model": "vibe-subscription" }
  }
}
```

Keep the gateway credential out of JSON and provide it as a redacted environment value:

```bash
export RIKA_MODEL_API_KEY="your-vibe-proxy-key"
rika config list
rika doctor
rika
```

The installed `rika` command and the OpenTUI session use the same resolved settings, durable Relay database, and Baton
model registration. Workspace settings override global settings without copying credentials into the repository.
