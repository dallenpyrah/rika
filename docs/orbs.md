# Orbs

Orbs run a thread inside a remote sandbox created from a Project profile.

## Provisioning

`OrbManager.provisionForThread` creates a staged orb row, starts an E2B sandbox with `thread_id` and `project_id` metadata, places the repository at `/home/user/repo`, runs setup there, starts `rika server`, waits for authenticated `/health`, then stores the endpoint and marks the orb running.

The default repository transfer path is a local git bundle. This supports local branches that have not been pushed to the Project origin.

Set `RIKA_ORB_CLONE=origin` to clone the Project `repo_origin` and `default_branch` instead. Origin clone mode is for repositories where the remote branch is the intended source of truth.

## Credentials

Project environment variables and Project secrets are injected only as per-command process environment for sandbox exec calls. They are not written to the repository bundle, sandbox files, diagnostics, command arguments, or orb records.

For private origin clones, store a Project secret named `GIT_TOKEN`. Rika passes it to the clone command environment as `GIT_TOKEN`; the token must not be embedded in the clone URL or persisted in git config.

The orb server token is generated per provisioning run and stored only through `OrbStore.endpointCredentials`. Normal orb record reads omit the token.
