# Git inspection

Agents use `git_status` for a concise view of the current branch, staged changes, unstaged changes, and untracked files in the Workspace. The tool runs Git without modifying the repository and returns bounded output.

A Workspace that is not a Git repository, a missing Git executable, timeout, or nonzero Git exit returns a typed tool failure. Other Git operations go through the shell contract rather than hidden Git tools.
