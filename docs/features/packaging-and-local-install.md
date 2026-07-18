# Packaging and local installation

`bun run package -- --target <target>` builds a self-contained archive for `darwin-arm64`, `darwin-x64`, `linux-arm64`, or `linux-x64`; without `--target` it builds every supported target. Archives, checksums, and release data are written under `artifacts`, and unsupported targets or failed builds stop the command.

`bun run install-local` installs an existing host archive under `~/.local/share/rika/current` and links `~/.local/bin/rika`; `RIKA_PACKAGE_TARGET`, `RIKA_INSTALL_ROOT`, and `RIKA_BIN_DIR` override target or paths. Installation replaces a prior owned install but refuses to overwrite an unrelated command. `bun run uninstall-local` removes only the owned command and installed program, preserving Rika state and configuration.
