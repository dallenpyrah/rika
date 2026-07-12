# ADR 0010: Effect CLI

Status: Accepted

## Context

CLI flags, help, validation, output, and exit behavior form a stable public contract. Hand-written parsing in v1 increased surface-specific logic.

## Decision

Every argument-bearing command and script uses `effect/unstable/cli`. Leaf modules export command values. The root CLI exports the command tree and testable `run(argv)` helper. Only the app entrypoint defines and interprets the process-boundary main program.

## Consequences

Flags and arguments are typed and Schema-validated. Help and parse errors come from Effect CLI. Business behavior remains behind Effect services and layers.

Infrastructure layers are acquired by handlers after parsing. Offline help and version output never start SQL, Relay, models, MCP, plugins, or OpenTUI.

## Rejected Alternatives

- Port v1's custom parser: rejected because it duplicates Effect CLI behavior.
- Commander or yargs: rejected because the product is Effect-native and these add a second runtime model.
- Hand-written Amp-compatible help: rejected because exact copied help is not a product requirement.
