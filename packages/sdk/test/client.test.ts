import { describe, expect, test } from "bun:test"
import { Codec, Common, Event, Ide, Ids, Remote } from "@rika/schema"
import { Effect, Schema, Stream } from "effect"
import { Client } from "../src/index"

const threadId = Ids.ThreadId.make("thread_sdk_client")
const workspaceId = Ids.WorkspaceId.make("workspace_sdk_client")
const projectId = Ids.ProjectId.make("project_sdk_client")
const orbId = Ids.OrbId.make("orb_sdk_client")
const turnId = Ids.TurnId.make("turn_sdk_client")
const eventId = Ids.EventId.make("event_sdk_client")
const ideClientId = Ids.IdeClientId.make("ide_sdk_client")
const userId = Ids.UserId.make("user_sdk_client")
const now = Common.TimestampMillis.make(2_000_000_000_001)

describe("SDK client", () => {
  test("uses shared schemas for requests, responses, and event streams", async () => {
    const calls: Array<Client.RequestInput> = []
    const summary: Remote.ThreadSummary = {
      thread_id: threadId,
      workspace_id: workspaceId,
      title_text: "ship",
      diff: { additions: 0, modifications: 0, deletions: 0 },
      archived: false,
      created_at: now,
      updated_at: now,
    }
    const started: Event.TurnStarted = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 1,
      version: 1,
      created_at: now,
      type: "turn.started",
      data: {},
    }

    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        if (input.path === "/v1/turns") {
          return Effect.succeed(Codec.encode(Remote.StartTurnResponse)({ thread_id: threadId, accepted: true }))
        }
        return Effect.succeed(Codec.encode(Remote.ThreadSummary)(summary))
      },
      streamJson: (input) => {
        calls.push(input)
        return Stream.make(Codec.encode(Event.Event)(started))
      },
    })

    const created = await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
    const accepted = await Effect.runPromise(
      client.startTurn({ thread_id: threadId, content: "ship", workspace_id: workspaceId }),
    )
    const events = await Effect.runPromise(
      client.subscribeThreadEvents({ thread_id: threadId }).pipe(Stream.runCollect),
    )

    expect(created).toEqual(summary)
    expect(accepted).toEqual({ thread_id: threadId, accepted: true })
    expect(events).toEqual([started])
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/threads",
        body: { thread_id: threadId, workspace_id: workspaceId },
      },
      {
        method: "POST",
        path: "/v1/turns",
        body: { thread_id: threadId, workspace_id: workspaceId, content: "ship" },
      },
      {
        method: "GET",
        path: "/v1/threads/thread_sdk_client/events",
      },
    ])
  })

  test("uses shared schemas for thread preview requests", async () => {
    const calls: Array<Client.RequestInput> = []
    const summary: Remote.ThreadSummary = {
      thread_id: threadId,
      workspace_id: workspaceId,
      title_text: "Preview me",
      latest_message_text: "Preview me",
      diff: { additions: 3, modifications: 1, deletions: 1 },
      archived: false,
      created_at: now,
      updated_at: now,
    }
    const record: Remote.ThreadRecord = { summary, events: [] }
    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        return Effect.succeed(Codec.encode(Remote.ThreadRecord)(record))
      },
      streamJson: () => Stream.empty,
    })

    const preview = await Effect.runPromise(client.previewThread(threadId, { limit: 80 }))

    expect(preview).toEqual(record)
    expect(calls).toEqual([{ method: "GET", path: "/v1/threads/thread_sdk_client/preview?limit=80" }])
  })

  test("uses shared schemas for project and orb-thread requests", async () => {
    const calls: Array<Client.RequestInput> = []
    const project: Remote.ProjectSummary = {
      project_id: projectId,
      name: "demo",
      repo_origin: "https://github.com/example/rika.git",
      default_branch: "main",
      template_id: null,
      env_keys: [],
      secret_names: [],
      created_at: now,
      updated_at: now,
    }
    const summary: Remote.ThreadSummary = {
      thread_id: threadId,
      workspace_id: Ids.WorkspaceId.make("project:project_sdk_client"),
      diff: { additions: 0, modifications: 0, deletions: 0 },
      orb_status: "running",
      archived: false,
      created_at: now,
      updated_at: now,
    }
    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        if (input.method === "GET" && input.path === "/v1/projects") {
          return Effect.succeed(Codec.encode(Schema.Array(Remote.ProjectSummary))([project]))
        }
        if (input.method === "POST" && input.path === "/v1/projects") {
          return Effect.succeed(Codec.encode(Remote.ProjectSummary)(project))
        }
        if (input.method === "POST" && input.path === "/v1/orbs") {
          return Effect.succeed(Codec.encode(Remote.ThreadSummary)(summary))
        }
        return Effect.fail(new Client.SdkError({ message: `unexpected ${input.path}`, operation: "requestJson" }))
      },
      streamJson: () => Stream.empty,
    })

    const projects = await Effect.runPromise(client.listProjects())
    const createdProject = await Effect.runPromise(
      client.createProject({ name: "demo", repo_origin: "https://github.com/example/rika.git" }),
    )
    const createdOrb = await Effect.runPromise(
      client.createOrbThread({ project_id: projectId, thread_id: threadId, mode: "smart" }),
    )

    expect(projects).toEqual([project])
    expect(createdProject).toEqual(project)
    expect(createdOrb).toEqual(summary)
    expect(calls).toEqual([
      { method: "GET", path: "/v1/projects" },
      {
        method: "POST",
        path: "/v1/projects",
        body: { name: "demo", repo_origin: "https://github.com/example/rika.git" },
      },
      {
        method: "POST",
        path: "/v1/orbs",
        body: { project_id: projectId, thread_id: threadId, mode: "smart" },
      },
    ])
  })

  test("uses shared schema for orb changes requests", async () => {
    const calls: Array<Client.RequestInput> = []
    const changes: Remote.OrbChangesResponse = {
      base_commit: "abc123",
      head_commit: "def456",
      diff: "diff --git a/README.md b/README.md\n",
      dirty: true,
    }
    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        return Effect.succeed(Codec.encode(Remote.OrbChangesResponse)(changes))
      },
      streamJson: () => Stream.empty,
    })

    const result = await Effect.runPromise(client.orbChanges())

    expect(result).toEqual(changes)
    expect(calls).toEqual([{ method: "GET", path: "/v1/orb/changes" }])
  })

  test("uses shared schemas for orb lifecycle endpoints without endpoint credentials", async () => {
    const calls: Array<Client.RequestInput> = []
    const summary: Remote.OrbSummary = {
      orb_id: orbId,
      thread_id: threadId,
      project_id: projectId,
      status: "running",
      base_commit: "abc123",
      created_at: now,
      last_active_at: now,
    }
    const paused: Remote.OrbSummary = { ...summary, status: "paused" }
    const killed: Remote.OrbSummary = { ...summary, status: "killed" }
    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        if (input.method === "GET" && input.path === "/v1/orbs") {
          return Effect.succeed(Codec.encode(Schema.Array(Remote.OrbSummary))([summary]))
        }
        if (input.method === "GET" && input.path === "/v1/orbs/by-thread/thread_sdk_client") {
          return Effect.succeed(Codec.encode(Remote.OrbSummary)(summary))
        }
        if (input.method === "POST" && input.path === "/v1/orbs/orb_sdk_client/pause") {
          return Effect.succeed(Codec.encode(Remote.OrbSummary)(paused))
        }
        if (input.method === "POST" && input.path === "/v1/orbs/orb_sdk_client/resume") {
          return Effect.succeed(Codec.encode(Remote.OrbSummary)(summary))
        }
        if (input.method === "POST" && input.path === "/v1/orbs/orb_sdk_client/kill") {
          return Effect.succeed(Codec.encode(Remote.OrbSummary)(killed))
        }
        return Effect.fail(new Client.SdkError({ message: `unexpected ${input.path}`, operation: "requestJson" }))
      },
      streamJson: () => Stream.empty,
    })

    const listed = await Effect.runPromise(client.listOrbs())
    const byThread = await Effect.runPromise(client.getOrbByThread(threadId))
    const pause = await Effect.runPromise(client.pauseOrb(orbId))
    const resume = await Effect.runPromise(client.resumeOrb(orbId))
    const kill = await Effect.runPromise(client.killOrb(orbId))

    expect(listed).toEqual([summary])
    expect(byThread).toEqual(summary)
    expect(pause).toEqual(paused)
    expect(resume).toEqual(summary)
    expect(kill).toEqual(killed)
    expect(JSON.stringify(listed)).not.toContain("orb-token")
    expect(JSON.stringify(listed)).not.toContain("orb.remote")
    expect(calls).toEqual([
      { method: "GET", path: "/v1/orbs" },
      { method: "GET", path: "/v1/orbs/by-thread/thread_sdk_client" },
      { method: "POST", path: "/v1/orbs/orb_sdk_client/pause" },
      { method: "POST", path: "/v1/orbs/orb_sdk_client/resume" },
      { method: "POST", path: "/v1/orbs/orb_sdk_client/kill" },
    ])
  })

  test("uses shared schema for manual thread compaction", async () => {
    const calls: Array<Client.RequestInput> = []
    const event: Event.ContextCompacted = {
      id: Ids.EventId.make("event_sdk_context_compacted"),
      thread_id: threadId,
      sequence: 2,
      version: 1,
      created_at: now,
      type: "context.compacted",
      data: {
        summary: "Goal\n- compacted",
        tail_start_sequence: 1,
        trigger: "manual",
        tokens_before: 100,
        model: "gpt-5.5",
      },
    }
    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        return Effect.succeed(Codec.encode(Event.ContextCompacted)(event))
      },
      streamJson: () => Stream.empty,
    })

    const compacted = await Effect.runPromise(client.compactThread(threadId, userId))

    expect(compacted).toEqual(event)
    expect(calls).toEqual([{ method: "POST", path: "/v1/threads/thread_sdk_client/compact?user_id=user_sdk_client" }])
  })

  test("uses shared schema for thread fork requests", async () => {
    const calls: Array<Client.RequestInput> = []
    const summary: Remote.ThreadSummary = {
      thread_id: Ids.ThreadId.make("thread_sdk_fork"),
      workspace_id: workspaceId,
      title_text: "forked",
      diff: { additions: 0, modifications: 0, deletions: 0 },
      archived: false,
      created_at: now,
      updated_at: now,
    }
    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        return Effect.succeed(Codec.encode(Remote.ThreadSummary)(summary))
      },
      streamJson: () => Stream.empty,
    })

    const forked = await Effect.runPromise(client.forkThread(threadId, { at_turn: turnId, user_id: userId }))

    expect(forked).toEqual(summary)
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/threads/thread_sdk_client/fork",
        body: { thread_id: threadId, at_turn: turnId, user_id: userId },
      },
    ])
  })

  test("fetch transport sends bearer auth and decodes API errors", async () => {
    let authorization: string | undefined
    const client = Client.make(
      Client.fetchTransport({
        base_url: "http://rika.test/",
        token: "secret",
        fetch: async (_input, init) => {
          authorization = new Headers(init?.headers).get("authorization") ?? undefined
          return new Response(JSON.stringify({ error: { message: "Unauthorized", code: "unauthorized" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
        },
      }),
    )

    const error = await Effect.runPromise(client.listThreads().pipe(Effect.flip))

    expect(authorization).toBe("Bearer secret")
    expect(error).toMatchObject({ message: "Unauthorized", operation: "requestJson", status: 401 })
  })

  test("turn submission preserves server API errors as SDK errors", async () => {
    const client = Client.make({
      requestJson: () =>
        Effect.succeed({
          error: { message: "Workspace denied", code: "workspace_denied", details: { status: 403 } },
        }),
      streamJson: () => Stream.empty,
    })

    const error = await Effect.runPromise(
      client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "ship" }).pipe(Effect.flip),
    )

    expect(error).toMatchObject({ message: "Workspace denied", operation: "startTurn", status: 403 })
  })

  test("uses shared schemas for IDE endpoints", async () => {
    const calls: Array<Client.RequestInput> = []
    const context: Ide.ContextSnapshot = {
      workspace_roots: ["/workspace/rika"],
      active_file: { path: "src/index.ts", selection: { range: { start_line: 1, end_line: 3 } } },
    }
    const navigationRequest: Ide.OpenFileRequest = {
      path: "src/index.ts",
      range: { start_line: 1, end_line: 3 },
      reason: "Show file",
    }
    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        switch (input.path) {
          case "/v1/ide/connect":
            return Effect.succeed(
              Codec.encode(Ide.ConnectResponse)({
                client_id: ideClientId,
                connected: true,
                capabilities: ["active-context", "navigation"],
              }),
            )
          case "/v1/ide/status":
            return Effect.succeed(
              Codec.encode(Ide.Status)({
                connected: true,
                client_id: ideClientId,
                capabilities: ["active-context", "navigation"],
                workspace_roots: ["/workspace/rika"],
                context,
              }),
            )
          case "/v1/ide/open-file":
            return Effect.succeed(Codec.encode(Ide.OpenFileResult)({ accepted: true }))
          case "/v1/ide/navigation-requests":
            return Effect.succeed(Codec.encode(Schema.Array(Ide.OpenFileRequest))([navigationRequest]))
        }
        return Effect.die(`unexpected request ${input.path}`)
      },
      streamJson: () => Stream.empty,
    })

    const connected = await Effect.runPromise(
      client.connectIde({
        client_id: ideClientId,
        workspace_roots: ["/workspace/rika"],
        capabilities: ["active-context", "navigation"],
        initial_context: context,
      }),
    )
    const status = await Effect.runPromise(client.ideStatus())
    const opened = await Effect.runPromise(client.openIdeFile(navigationRequest))
    const requests = await Effect.runPromise(client.ideNavigationRequests())

    expect(connected).toEqual({
      client_id: ideClientId,
      connected: true,
      capabilities: ["active-context", "navigation"],
    })
    expect(status).toMatchObject({ connected: true, client_id: ideClientId, context })
    expect(opened).toEqual({ accepted: true })
    expect(requests).toEqual([navigationRequest])
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/ide/connect",
        body: {
          client_id: ideClientId,
          workspace_roots: ["/workspace/rika"],
          capabilities: ["active-context", "navigation"],
          initial_context: context,
        },
      },
      { method: "GET", path: "/v1/ide/status" },
      { method: "POST", path: "/v1/ide/open-file", body: navigationRequest },
      { method: "GET", path: "/v1/ide/navigation-requests" },
    ])
  })
})
