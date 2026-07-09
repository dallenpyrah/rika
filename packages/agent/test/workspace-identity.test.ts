import { describe, expect, test } from "bun:test"
import { Ids } from "@rika/schema"
import { WorkspaceIdentity } from "../src/index"

describe("workspace identity", () => {
  test("uses the local workspace root as the workspace identity", () => {
    const workspaceId = WorkspaceIdentity.resolveWorkspaceId({ workspace_root: "/Users/me/rika" })

    expect(workspaceId).toBe(Ids.WorkspaceId.make("/Users/me/rika"))
  })
})
