# ADR 0002: Published Framework Dependencies

Status: Amended

## Context

Rika needs Baton agent behavior and Relay durability while preserving clean ownership and proving both frameworks as reusable packages.

## Decision

Rika consumes released Baton and Relay packages from the registry using pinned versions and public exports only.

During coordinated local development, an explicit non-persistent link overlay may replace those installed packages with sibling Baton and Relay public package directories. The committed manifest and lockfile retain registry versions, CI always installs from the frozen lockfile, and release verification restores registry mode. Local linking never permits internal deep imports or source copies.

## Consequences

Missing capabilities are implemented and tested upstream before Rika adopts them. Final release evidence still requires published packages and clean registry installation. The local link overlay shortens coordinated development cycles without changing the package boundary or committed dependency contract.

## Rejected Alternatives

- Copy framework source into Rika: rejected because fixes and contracts would diverge.
- Commit sibling workspace or file links: rejected because they do not prove package correctness for external consumers.
- Import internal packages directly: rejected because it couples Rika to unsupported implementation structure.
