# Shell processes

Agents use `shell` to start one command with arguments in the Workspace and `shell_command_status` to wait for new output from a still-running process. A call may wait up to two minutes; longer-running commands return a process identifier, and later polls return only newly retained output.

Working directories stay inside the Workspace. Output is continuously drained but bounded in memory and responses; unknown or completed process identifiers fail, and processes still running when their owning scope closes are terminated.
