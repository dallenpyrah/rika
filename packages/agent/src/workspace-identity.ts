import { Ids } from "@rika/schema"

export interface ResolveWorkspaceIdInput {
  readonly workspace_root: string
}

export const resolveWorkspaceId = (input: ResolveWorkspaceIdInput): Ids.WorkspaceId =>
  Ids.WorkspaceId.make(input.workspace_root)
