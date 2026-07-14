# MCP and Plugins

## MCP

Published Baton MCP adapters own MCP tool discovery and calls over their supported transports. Rika owns server configuration, trust, OAuth credentials, filters, resource adaptation, diagnostics, and skill-bundled `mcp.json` behavior.

Rika composes Baton's OAuth lifecycle for remote MCP transports. Rika opens the system browser, hosts the loopback callback, and persists redacted token documents in a mode-0600 local credential file. Login, logout, and typed authentication status are available through the MCP command tree. MCP resources, prompts, and dynamic tool refresh remain framework-blocked until a released package contract is proven or Rika supplies a product adapter without bypassing Baton tool execution.

## Plugins

Trusted local TypeScript plugins may register tools, commands, policy hooks, agents, modes, and bounded TUI actions. Plugins cannot import product internals through unsupported paths.

Executable workspace extensions remain disabled until explicitly trusted. Plugin failures are isolated, diagnosed, and never silently ignored when they affect an accepted operation.

Trust records include Workspace identity, extension id, source hash, configuration fingerprint, verification result, generation, and tool-schema digest. Active and resumed executions use their pinned extension generation or fail typed if it is unavailable. Reload affects future executions only.

MCP command approval includes Workspace root, server name, command, arguments, environment-name fingerprint, and effective working directory. Secrets are not persisted in trust records or execution events.

## Transport

Remote MCP transport follows the MCP package contract. Rika-owned client-to-resident-service execution transport uses WebSockets rather than SSE.
