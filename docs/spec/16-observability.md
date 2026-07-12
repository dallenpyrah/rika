# Observability and Diagnostics

## Diagnostics

Rika records structured local diagnostics for commands, executions, tools, children, workflows, SQL operations, renderer lifecycle, transport connections, and failures.

## Security

Secrets and full prompt/response bodies are not logged by default. Configured secrets are redacted at diagnostic boundaries. Local diagnostic stores are treated as sensitive data.

## Telemetry

OpenTelemetry export is opt-in. Runtime behavior never depends on telemetry availability.

## User Surface

The CLI provides doctor, local report export, log location/configuration, effective configuration, dependency versions, database migration state, MCP status, and execution replay diagnostics.
