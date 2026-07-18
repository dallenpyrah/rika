# Layered configuration

Rika reads global settings from `~/.config/rika/settings.json` and Workspace settings from `.rika/settings.json`. Workspace values take precedence over global values, with map-shaped settings merged by key; invalid files or unsupported fields fail configuration loading instead of being ignored.

`rika config list` prints effective settings and their sources, using presence markers rather than credential values. `rika config edit` opens the global file, `rika config edit --workspace` opens the Workspace file, and `rika config keymap` prints the effective key bindings; provider endpoint and credential-environment rules are separate from this general precedence contract.
