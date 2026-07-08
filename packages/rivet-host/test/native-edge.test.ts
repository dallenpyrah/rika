import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PresenceHub, WorkspaceAccess, WorkspaceIdentity } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { OrbChanges, OrbFiles, OrbManager, OrbPty } from "@rika/orb"
import {
  ArtifactStore,
  Database,
  Migration,
  OrbStore,
  ProjectStore,
  ThreadEventLog,
  ThreadProjection,
  WorkspaceStore,
} from "@rika/persistence"
import { Codec, Common, Event, Ide, Ids, Message, Remote, Workspace } from "@rika/schema"
import { Client } from "@rika/sdk"
import { Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { NativeEdge, ThreadActor, ThreadClient, ThreadDirectory } from "../src/index"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const threadId = Ids.ThreadId.make("native_edge_thread")
const workspaceId = Ids.WorkspaceId.make("native_edge_workspace")
const ownerUserId = Ids.UserId.make("native_edge_owner")
const otherUserId = Ids.UserId.make("native_edge_other")
const failingOrbProjectId = Ids.ProjectId.make("native_edge_orb_project_fail")
const postProvisionActorFailureThreadId = Ids.ThreadId.make("native_edge_post_provision_actor_failure")
const testRoot = join(tmpdir(), `rika-native-edge-test-${process.pid}-${Date.now()}`)
type ThreadEventMap = Map<Ids.ThreadId, Array<Event.Event>>
const fakeStartTurnInputs: Array<ThreadActor.StartTurnPayload> = []

describe("NativeEdge", () => {
  test("serves SDK-compatible health, create, open, start, and replay routes", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        const health = yield* client.backendHealth()
        const created = yield* client.createThread({ thread_id: threadId, workspace_id: workspaceId })
        const opened = yield* client.openThread(threadId)
        const accepted = yield* client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "ship it" })
        const events = yield* client
          .subscribeThreadEvents({ thread_id: threadId, after_sequence: 0 })
          .pipe(Stream.take(5))
          .pipe(Stream.runCollect)
        return { health, created, opened, events, accepted }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.health).toMatchObject({
      status: "healthy",
      backend_id: "native-rivet-edge-test",
    })
    expect(result.created).toMatchObject({
      thread_id: threadId,
      workspace_id: workspaceId,
      archived: false,
      visibility: "private",
    })
    expect(result.opened.summary.thread_id).toBe(threadId)
    expect(result.opened.events.map((event) => event.type)).toEqual(["thread.created"])
    expect(Array.from(result.events).map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "message.added",
      "turn.completed",
    ])
    expect(result.accepted).toEqual({ thread_id: threadId, accepted: true })
  })

  test("serves SDK-compatible project management routes", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        const created = yield* client.createProject({
          name: "demo",
          repo_origin: "https://user:token@github.com/example/rika.git?private=1#readme",
          default_branch: "trunk",
          template_id: null,
          env: { BETA: "2", ALPHA: "1" },
        })
        const listed = yield* client.listProjects()
        const updated = yield* client.updateProject(created.project_id, {
          name: "demo-renamed",
          repo_origin: "https://github.com/example/rika-renamed.git",
          env: { GAMMA: "3" },
        })
        const withSecret = yield* client.setProjectSecret(created.project_id, "OPENROUTER_API_KEY", {
          value: "secret",
        })
        const withoutSecret = yield* client.deleteProjectSecret(created.project_id, "OPENROUTER_API_KEY")
        const fetched = yield* client.getProject(created.project_id)
        return { created, listed, updated, withSecret, withoutSecret, fetched }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.created).toMatchObject({
      name: "demo",
      repo_origin: "https://github.com/example/rika.git",
      default_branch: "trunk",
      template_id: null,
      env: { ALPHA: "1", BETA: "2" },
      secret_names: [],
    })
    expect(result.listed.map((project) => project.name)).toEqual(["demo"])
    expect(result.listed[0]).toMatchObject({
      repo_origin: "https://github.com/example/rika.git",
      env_keys: ["ALPHA", "BETA"],
      secret_names: [],
    })
    expect(result.updated).toMatchObject({
      name: "demo-renamed",
      repo_origin: "https://github.com/example/rika-renamed.git",
      env: { GAMMA: "3" },
    })
    expect(result.withSecret.secret_names).toEqual(["OPENROUTER_API_KEY"])
    expect(result.withoutSecret.secret_names).toEqual([])
    expect(result.fetched).toMatchObject({
      name: "demo-renamed",
      env: { GAMMA: "3" },
      secret_names: [],
    })
  })

  test("returns not found for missing project management routes", async () => {
    const missingProjectId = Ids.ProjectId.make("native_edge_missing_project")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const fetched = yield* edge.handle(
          new Request(`http://native-edge.test/v1/projects/${missingProjectId}`, {
            headers: { authorization: "Bearer secret" },
          }),
        )
        const updated = yield* edge.handle(
          new Request(`http://native-edge.test/v1/projects/${missingProjectId}`, {
            method: "PATCH",
            headers: { authorization: "Bearer secret" },
            body: JSON.stringify(Codec.encode(Remote.UpdateProjectRequest)({ name: "missing" })),
          }),
        )
        const secret = yield* edge.handle(
          new Request(`http://native-edge.test/v1/projects/${missingProjectId}/secrets/API_KEY`, {
            method: "PUT",
            headers: { authorization: "Bearer secret" },
            body: JSON.stringify(Codec.encode(Remote.SetProjectSecretRequest)({ value: "secret" })),
          }),
        )
        const deletedSecret = yield* edge.handle(
          new Request(`http://native-edge.test/v1/projects/${missingProjectId}/secrets/API_KEY`, {
            method: "DELETE",
            headers: { authorization: "Bearer secret" },
          }),
        )
        return { fetched, updated, secret, deletedSecret }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.fetched.status).toBe(404)
    expect(result.updated.status).toBe(404)
    expect(result.secret.status).toBe(404)
    expect(result.deletedSecret.status).toBe(404)
  })

  test("streams NDJSON frames after the requested sequence", async () => {
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        yield* edge.handle(
          new Request("http://native-edge.test/v1/threads", {
            method: "POST",
            headers: { authorization: "Bearer secret" },
            body: JSON.stringify(
              Codec.encode(Remote.CreateThreadRequest)({ thread_id: threadId, workspace_id: workspaceId }),
            ),
          }),
        )
        yield* edge.handle(
          new Request("http://native-edge.test/v1/turns", {
            method: "POST",
            headers: { authorization: "Bearer secret" },
            body: JSON.stringify(
              Codec.encode(Remote.StartTurnRequest)({
                thread_id: threadId,
                workspace_id: workspaceId,
                content: "seed replay",
              }),
            ),
          }),
        )
        return yield* edge.handle(
          new Request(`http://native-edge.test/v1/threads/${threadId}/events?after_sequence=1`, {
            headers: { authorization: "Bearer secret" },
          }),
        )
      }).pipe(Effect.provide(edgeLayer)),
    )
    const lines = await readNdjsonLines(response, 5)
    const decoded = lines.map((line) => Codec.decode(Remote.StreamFrame)(JSON.parse(line)))

    expect(response.headers.get("content-type")).toBe("application/x-ndjson")
    expect(decoded.filter((event) => "type" in event).map((event) => event.type)).toEqual([
      "turn.started",
      "message.added",
      "message.added",
      "turn.completed",
    ])
  })

  test("keeps the SDK event stream open for events appended after subscription", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.createThread({ thread_id: threadId, workspace_id: workspaceId })
        const fiber = yield* client
          .subscribeThreadEvents({ thread_id: threadId, after_sequence: 1 })
          .pipe(Stream.take(4), Stream.runCollect, Effect.forkChild)
        yield* Effect.sleep("20 millis")
        yield* client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "tail me" })
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(Array.from(result).map((event) => event.type)).toEqual([
      "turn.started",
      "message.added",
      "message.added",
      "turn.completed",
    ])
  })

  test("serves SDK-compatible IDE bridge routes", async () => {
    fakeStartTurnInputs.length = 0
    const ideClientId = Ids.IdeClientId.make("native_edge_ide_client")
    const staleIdeClientId = Ids.IdeClientId.make("native_edge_stale_ide_client")
    const ideThreadId = Ids.ThreadId.make("native_edge_ide_context_thread")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        const before = yield* client.ideStatus()
        const beforeOpen = yield* client.openIdeFile({ path: "README.md" })
        const connected = yield* client.connectIde({
          client_id: ideClientId,
          name: "Native Edge IDE",
          workspace_roots: [testRoot],
          capabilities: ["active-context", "navigation"],
          initial_context: {
            workspace_roots: [testRoot],
            active_file: {
              path: "src/index.ts",
              language_id: "typescript",
              selection: {
                range: { start_line: 1, end_line: 2 },
                selected_text: "const answer = 42",
              },
            },
          },
        })
        const status = yield* client.ideStatus()
        const updated = yield* client.updateIdeContext({
          client_id: ideClientId,
          context: {
            workspace_roots: [testRoot],
            diagnostics: [
              {
                path: "src/index.ts",
                severity: "warning",
                message: "check this line",
                range: { start_line: 3, end_line: 3 },
                source: "native-edge-test",
              },
            ],
          },
        })
        const opened = yield* client.openIdeFile({
          path: "src/app.ts",
          range: { start_line: 4, end_line: 5 },
          preview: true,
          reason: "native route test",
          thread_id: threadId,
        })
        const requests = yield* client.ideNavigationRequests()
        const staleUpdate = yield* client
          .updateIdeContext({ client_id: staleIdeClientId, context: { workspace_roots: [testRoot] } })
          .pipe(Effect.flip)
        yield* client.startTurn({ thread_id: ideThreadId, workspace_id: workspaceId, content: "use ide context" })
        const disconnected = yield* client.disconnectIde({ client_id: ideClientId })
        const after = yield* client.ideStatus()
        return { before, beforeOpen, connected, status, updated, opened, requests, staleUpdate, disconnected, after }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.before).toEqual({ connected: false, capabilities: [], workspace_roots: [] } satisfies Ide.Status)
    expect(result.beforeOpen).toEqual({ accepted: false, message: "No IDE client is connected" })
    expect(result.connected).toEqual({
      client_id: ideClientId,
      connected: true,
      capabilities: ["active-context", "navigation"],
    })
    expect(result.status).toMatchObject({
      connected: true,
      client_id: ideClientId,
      name: "Native Edge IDE",
      workspace_roots: [testRoot],
      context: { active_file: { path: "src/index.ts" } },
    })
    expect(result.updated.context).toMatchObject({
      diagnostics: [{ path: "src/index.ts", severity: "warning", message: "check this line" }],
    })
    expect(result.opened).toEqual({ accepted: true })
    expect(result.requests).toEqual([
      {
        path: "src/app.ts",
        range: { start_line: 4, end_line: 5 },
        preview: true,
        reason: "native route test",
        thread_id: threadId,
      },
    ])
    expect(result.staleUpdate.message).toBe("IDE client native_edge_stale_ide_client is not connected")
    expect(result.staleUpdate.status).toBe(409)
    expect(fakeStartTurnInputs.find((input) => input.thread_id === ideThreadId)?.ide_context).toMatchObject({
      diagnostics: [{ path: "src/index.ts", severity: "warning", message: "check this line" }],
    })
    expect(result.disconnected).toEqual({ connected: false, capabilities: [], workspace_roots: [] })
    expect(result.after).toEqual({ connected: false, capabilities: [], workspace_roots: [] })
  })

  test("serves SDK-compatible orb lifecycle routes", async () => {
    const orbThreadId = Ids.ThreadId.make("native_edge_orb_thread")
    const projectId = Ids.ProjectId.make("native_edge_orb_project")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        const created = yield* client.createOrbThread({ thread_id: orbThreadId, project_id: projectId })
        const opened = yield* client.openThread(orbThreadId)
        const listed = yield* client.listOrbs()
        const orb = yield* client.getOrbByThread(orbThreadId)
        const paused = yield* client.pauseOrb(orb.orb_id)
        const resumed = yield* client.resumeOrb(orb.orb_id)
        const killed = yield* client.killOrb(orb.orb_id)
        const missing = yield* client
          .getOrbByThread(Ids.ThreadId.make("native_edge_missing_orb_thread"))
          .pipe(Effect.flip)
        return { created, opened, listed, orb, paused, resumed, killed, missing }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.created).toMatchObject({
      thread_id: orbThreadId,
      workspace_id: WorkspaceIdentity.resolveWorkspaceId({ workspace_root: testRoot, project_id: projectId }),
      orb_status: "running",
      archived: false,
      visibility: "private",
    })
    expect(result.opened.summary.thread_id).toBe(orbThreadId)
    expect(result.opened.summary.orb_status).toBe("running")
    expect(result.opened.events.map((event) => event.type)).toEqual(["thread.created"])
    expect(result.listed.some((orb) => orb.thread_id === orbThreadId)).toBe(true)
    expect(result.orb).toMatchObject({ thread_id: orbThreadId, project_id: projectId, status: "running" })
    expect(Object.hasOwn(result.orb, "token")).toBe(false)
    expect(Object.hasOwn(result.orb, "endpoint_url")).toBe(false)
    expect(result.paused.status).toBe("paused")
    expect(result.resumed.status).toBe("running")
    expect(result.killed.status).toBe("killed")
    expect(result.missing.status).toBe(404)
  })

  test("does not create an actor thread when orb provisioning fails", async () => {
    const failedOrbThreadId = Ids.ThreadId.make("native_edge_failed_orb_thread")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        const created = yield* client
          .createOrbThread({ thread_id: failedOrbThreadId, project_id: failingOrbProjectId })
          .pipe(Effect.flip)
        const opened = yield* client.openThread(failedOrbThreadId).pipe(Effect.flip)
        return { created, opened }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.created.status).toBe(404)
    expect(result.opened.status).toBe(404)
  })

  test("does not create an orb row when orb thread creation is not authorized", async () => {
    const deniedOrbThreadId = Ids.ThreadId.make("native_edge_denied_orb_thread")
    const projectId = Ids.ProjectId.make("native_edge_denied_orb_project")
    const projectWorkspaceId = WorkspaceIdentity.resolveWorkspaceId({ workspace_root: testRoot, project_id: projectId })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* WorkspaceStore.putMembership(membership(otherUserId, "member", projectWorkspaceId))
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: `user:${ownerUserId}:secret`,
            fetch: fetchFrom(edge),
          }),
        )
        const created = yield* client
          .createOrbThread({ thread_id: deniedOrbThreadId, project_id: projectId })
          .pipe(Effect.flip)
        const orbStore = yield* OrbStore.Service
        const orb = yield* orbStore.getByThread(deniedOrbThreadId)
        return { created, orb }
      }).pipe(Effect.provide(edgeLayerForToken(`user:${ownerUserId}:secret`, new Map()))),
    )

    expect(result.created.status).toBe(403)
    expect(result.orb).toBeUndefined()
  })

  test("attempts force-kill cleanup when actor creation fails after provisioning", async () => {
    const projectId = Ids.ProjectId.make("native_edge_post_provision_orb_project")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        const created = yield* client
          .createOrbThread({ thread_id: postProvisionActorFailureThreadId, project_id: projectId })
          .pipe(Effect.flip)
        const orbStore = yield* OrbStore.Service
        const orb = yield* orbStore.getByThread(postProvisionActorFailureThreadId)
        return { created, orb }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.created.status).toBe(409)
    expect(result.orb?.status).toBe("killed")
  })

  test("carries orb status into user-scoped thread lists", async () => {
    const orbThreadId = Ids.ThreadId.make("native_edge_user_orb_thread")
    const projectId = Ids.ProjectId.make("native_edge_user_orb_project")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: `user:${ownerUserId}:secret`,
            fetch: fetchFrom(edge),
          }),
        )
        const created = yield* client.createOrbThread({ thread_id: orbThreadId, project_id: projectId })
        const listed = yield* client.listThreads({ workspace_id: created.workspace_id, user_id: ownerUserId })
        return listed.find((summary) => summary.thread_id === orbThreadId)
      }).pipe(Effect.provide(edgeLayerForToken(`user:${ownerUserId}:secret`, new Map()))),
    )

    expect(result?.orb_status).toBe("running")
  })

  test("rejects orb creation when the requested thread id belongs to another workspace", async () => {
    const reusedThreadId = Ids.ThreadId.make("native_edge_reused_orb_thread")
    const projectId = Ids.ProjectId.make("native_edge_reused_orb_project")
    const projectWorkspaceId = WorkspaceIdentity.resolveWorkspaceId({ workspace_root: testRoot, project_id: projectId })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.createThread({ thread_id: reusedThreadId, workspace_id: workspaceId })
        const created = yield* client
          .createOrbThread({ thread_id: reusedThreadId, project_id: projectId })
          .pipe(Effect.flip)
        const opened = yield* client.openThread(reusedThreadId)
        return { created, opened, projectWorkspaceId }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.created.status).toBe(409)
    expect(result.opened.summary.workspace_id).toBe(workspaceId)
    expect(result.opened.summary.workspace_id).not.toBe(result.projectWorkspaceId)
  })

  test("serves SDK-compatible interrupt route", async () => {
    const interruptThreadId = Ids.ThreadId.make("native_edge_interrupt_thread")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.startTurn({ thread_id: interruptThreadId, workspace_id: workspaceId, content: "interrupt me" })
        const first = yield* client.interruptTurn({ thread_id: interruptThreadId, turn_id: turnId, reason: "stop" })
        const second = yield* client.interruptTurn({ thread_id: interruptThreadId, turn_id: turnId, reason: "again" })
        const record = yield* client.openThread(interruptThreadId)
        return { first, second, record }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.first.type).toBe("turn.completed")
    expect(result.second.id).toBe(result.first.id)
    expect(result.record.events.filter((event) => event.type === "turn.failed")).toEqual([])
  })

  test("interrupts actor-only threads without projection candidates", async () => {
    const interruptActorOnlyThreadId = Ids.ThreadId.make("native_edge_interrupt_actor_only_thread")
    const sharedThreads: ThreadEventMap = new Map([
      [
        interruptActorOnlyThreadId,
        [
          threadCreatedForUser(interruptActorOnlyThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
          turnStartedFor(interruptActorOnlyThreadId, 2, Common.TimestampMillis.make(11), ownerUserId),
          messageAddedFor(interruptActorOnlyThreadId, 3, Common.TimestampMillis.make(12), "interrupt actor needle"),
        ],
      ],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadProjection.clear()
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        const interrupted = yield* client.interruptTurn({
          thread_id: interruptActorOnlyThreadId,
          turn_id: turnId,
          reason: "stop",
        })
        const listed = yield* client.listThreads({ workspace_id: workspaceId })
        const searched = yield* client.searchThreads({ workspace_id: workspaceId, query: "interrupt" })
        return { interrupted, listed, searched }
      }).pipe(Effect.provide(edgeLayerForToken("secret", sharedThreads))),
    )

    expect(result.interrupted.type).toBe("turn.failed")
    expect(result.listed.map((summary) => summary.thread_id)).toEqual([interruptActorOnlyThreadId])
    expect(result.searched.map((item) => item.summary.thread_id)).toEqual([interruptActorOnlyThreadId])
  })

  test("streams presence frames alongside actor events", async () => {
    const presenceThreadId = Ids.ThreadId.make("native_edge_presence_thread")
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: `user:${ownerUserId}:secret`,
            user_id: ownerUserId,
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.createThread({ thread_id: presenceThreadId, workspace_id: workspaceId })
        yield* client.setThreadPresence({ thread_id: presenceThreadId, user_id: ownerUserId, state: "active" })
        return yield* edge.handle(
          new Request(`http://native-edge.test/v1/threads/${presenceThreadId}/events?user_id=${ownerUserId}`, {
            headers: { authorization: `Bearer user:${ownerUserId}:secret` },
          }),
        )
      }).pipe(Effect.provide(edgeLayerForToken(`user:${ownerUserId}:secret`, new Map()))),
    )
    const frames = (await readNdjsonLines(response, 2)).map((line) =>
      Codec.decode(Remote.StreamFrame)(JSON.parse(line)),
    )

    expect(frames.filter((frame) => "type" in frame).map((frame) => frame.type)).toEqual(["thread.created"])
    expect(frames.filter((frame) => "presence" in frame).map((frame) => frame.presence)).toContainEqual({
      thread_id: presenceThreadId,
      users: [{ user_id: ownerUserId, state: "active", last_seen: Common.TimestampMillis.make(1_900_000_000_000) }],
    })
  })

  test("serves SDK-compatible artifact list and get routes", async () => {
    const artifactThreadId = Ids.ThreadId.make("native_edge_artifact_thread")
    const artifactId = Ids.ArtifactId.make("native_edge_artifact")
    const now = Common.TimestampMillis.make(1_900_000_000_010)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.createThread({ thread_id: artifactThreadId, workspace_id: workspaceId })
        yield* ArtifactStore.put({
          id: artifactId,
          thread_id: artifactThreadId,
          kind: "research",
          title: "Native edge artifact",
          content: { ok: true },
          created_at: now,
        })
        const listed = yield* client.listArtifacts({ thread_id: artifactThreadId, kind: "research" })
        const fetched = yield* client.getArtifact(artifactId)
        return { listed, fetched }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.listed.map((artifact) => artifact.id)).toEqual([artifactId])
    expect(result.fetched).toEqual({
      id: artifactId,
      thread_id: artifactThreadId,
      workspace_id: workspaceId,
      kind: "research",
      title: "Native edge artifact",
      content: { ok: true },
      created_at: now,
    })
  })

  test("gates artifact routes with verified actor read access", async () => {
    const artifactThreadId = Ids.ThreadId.make("native_edge_private_artifact_thread")
    const artifactId = Ids.ArtifactId.make("native_edge_private_artifact")
    const sharedThreads: ThreadEventMap = new Map([
      [
        artifactThreadId,
        [
          threadCreatedForUser(
            artifactThreadId,
            workspaceId,
            ownerUserId,
            Common.TimestampMillis.make(1_900_000_000_011),
          ),
        ],
      ],
    ])
    const otherToken = `user:${otherUserId}:secret`
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadProjection.apply(
          threadCreatedForUser(
            artifactThreadId,
            workspaceId,
            ownerUserId,
            Common.TimestampMillis.make(1_900_000_000_011),
          ),
        )
        yield* ArtifactStore.put({
          id: artifactId,
          thread_id: artifactThreadId,
          kind: "research",
          title: "Private native edge artifact",
          content: { ok: true },
          created_at: Common.TimestampMillis.make(1_900_000_000_012),
        })
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: otherToken,
            fetch: fetchFrom(edge),
          }),
        )
        const list = yield* client.listArtifacts({ thread_id: artifactThreadId, kind: "research" }).pipe(Effect.flip)
        const get = yield* client.getArtifact(artifactId).pipe(Effect.flip)
        return { list, get }
      }).pipe(Effect.provide(edgeLayerForToken(otherToken, sharedThreads))),
    )

    expect(result.list).toMatchObject({ status: 403 })
    expect(result.get).toMatchObject({ status: 403 })
  })

  test("does not leak private presence to verified outsiders", async () => {
    const presenceThreadId = Ids.ThreadId.make("native_edge_private_presence_thread")
    const sharedThreads: ThreadEventMap = new Map()
    const ownerToken = `user:${ownerUserId}:secret`
    const otherToken = `user:${otherUserId}:secret`
    await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: ownerToken,
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.createThread({ thread_id: presenceThreadId, workspace_id: workspaceId })
        yield* client.setThreadPresence({ thread_id: presenceThreadId, user_id: ownerUserId, state: "active" })
      }).pipe(Effect.provide(edgeLayerForToken(ownerToken, sharedThreads))),
    )
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        return yield* edge.handle(
          new Request(`http://native-edge.test/v1/threads/${presenceThreadId}/events?user_id=${ownerUserId}`, {
            headers: { authorization: `Bearer ${otherToken}` },
          }),
        )
      }).pipe(Effect.provide(edgeLayerForToken(otherToken, sharedThreads))),
    )
    const body = await response.text()

    expect(response.status).toBe(403)
    expect(body).not.toContain(ownerUserId)
  })

  test("does not close a live SDK event stream because replay includes an old terminal turn", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.createThread({ thread_id: threadId, workspace_id: workspaceId })
        yield* client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "first turn" })
        const fiber = yield* client
          .subscribeThreadEvents({ thread_id: threadId, after_sequence: 0 })
          .pipe(Stream.take(9), Stream.runCollect, Effect.forkChild)
        yield* Effect.sleep("20 millis")
        yield* client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "second turn" })
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(Array.from(result).map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "message.added",
      "turn.completed",
      "turn.started",
      "message.added",
      "message.added",
      "turn.completed",
    ])
  })

  test("serves SDK preview through the actor event record", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.createThread({ thread_id: threadId, workspace_id: workspaceId })
        yield* client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "preview me" })
        return yield* client.previewThread(threadId)
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.summary.thread_id).toBe(threadId)
    expect(result.summary.latest_message_text).toBe("native edge response")
    expect(result.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "message.added",
      "turn.completed",
    ])
  })

  test("starts existing threads with their actor-owned workspace when request omits workspace", async () => {
    const existingWorkspaceThreadId = Ids.ThreadId.make("native_edge_existing_workspace_turn")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.createThread({ thread_id: existingWorkspaceThreadId, workspace_id: workspaceId })
        const accepted = yield* client.startTurn({
          thread_id: existingWorkspaceThreadId,
          content: "use existing workspace",
        })
        const record = yield* client.openThread(existingWorkspaceThreadId)
        return { accepted, record }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.accepted).toEqual({ thread_id: existingWorkspaceThreadId, accepted: true })
    expect(result.record.summary.workspace_id).toBe(workspaceId)
    expect(result.record.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "message.added",
      "turn.completed",
    ])
  })

  test("starts existing threads with their actor-owned workspace when request sends a different workspace", async () => {
    const existingWorkspaceThreadId = Ids.ThreadId.make("native_edge_existing_explicit_workspace_turn")
    const wrongWorkspaceId = Ids.WorkspaceId.make("native_edge_wrong_workspace")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.createThread({ thread_id: existingWorkspaceThreadId, workspace_id: workspaceId })
        const accepted = yield* client.startTurn({
          thread_id: existingWorkspaceThreadId,
          workspace_id: wrongWorkspaceId,
          content: "use actor workspace",
        })
        const record = yield* client.openThread(existingWorkspaceThreadId)
        return { accepted, record }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.accepted).toEqual({ thread_id: existingWorkspaceThreadId, accepted: true })
    expect(result.record.summary.workspace_id).toBe(workspaceId)
    expect(result.record.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "message.added",
      "turn.completed",
    ])
  })

  test("archives and unarchives threads through actor events and projected lists", async () => {
    const archiveThreadId = Ids.ThreadId.make("native_edge_archive_thread")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.createThread({ thread_id: archiveThreadId, workspace_id: workspaceId })
        const archived = yield* client.archiveThread(archiveThreadId)
        const defaultList = yield* client.listThreads({ workspace_id: workspaceId })
        const archivedList = yield* client.listThreads({ workspace_id: workspaceId, include_archived: true })
        const unarchived = yield* client.unarchiveThread(archiveThreadId)
        const opened = yield* client.openThread(archiveThreadId)
        return { archived, defaultList, archivedList, unarchived, opened }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.archived.archived).toBe(true)
    expect(result.defaultList.map((summary) => summary.thread_id)).not.toContain(archiveThreadId)
    expect(result.archivedList.find((summary) => summary.thread_id === archiveThreadId)?.archived).toBe(true)
    expect(result.unarchived.archived).toBe(false)
    expect(result.opened.summary.archived).toBe(false)
    expect(result.opened.events.map((event) => event.type)).toEqual([
      "thread.created",
      "thread.archived",
      "thread.unarchived",
    ])
  })

  test("compacts threads through actor events and projected replay", async () => {
    const compactThreadId = Ids.ThreadId.make("native_edge_compact_thread")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.startTurn({ thread_id: compactThreadId, workspace_id: workspaceId, content: "compact me" })
        const compacted = yield* client.compactThread(compactThreadId)
        const opened = yield* client.openThread(compactThreadId)
        const listed = yield* client.listThreads({ workspace_id: workspaceId })
        return { compacted, opened, listed }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.compacted).toMatchObject({
      thread_id: compactThreadId,
      sequence: 6,
      type: "context.compacted",
      data: {
        trigger: "manual",
        summary: "native edge compacted summary",
        model: "native-edge-test",
      },
    })
    expect(result.opened.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "message.added",
      "turn.completed",
      "context.compacted",
    ])
    expect(result.listed.find((summary) => summary.thread_id === compactThreadId)?.updated_at).toBe(
      result.compacted.created_at,
    )
  })

  test("serves SDK-compatible thread share exports and compact references", async () => {
    const referenceThreadId = Ids.ThreadId.make("native_edge_reference_thread")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.startTurn({
          thread_id: referenceThreadId,
          workspace_id: workspaceId,
          content: "document auth handoff",
        })
        const exported = yield* client.shareThread(referenceThreadId)
        const reference = yield* client.referenceThread({ thread_id: referenceThreadId, query: "handoff" })
        return { exported, reference }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.exported).toMatchObject({
      schema_version: 1,
      thread_id: referenceThreadId,
      summary: { thread_id: referenceThreadId, latest_message_text: "native edge response" },
    })
    expect(result.exported.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "message.added",
      "turn.completed",
    ])
    expect(result.reference.thread_id).toBe(referenceThreadId)
    expect(result.reference.entries).toContain(`Thread ${referenceThreadId}`)
    expect(result.reference.rendered).toContain("document auth handoff")
    expect(result.reference.total_chars).toBe(result.reference.rendered.length)
    expect(result.reference.truncated).toBe(false)
  })

  test("forks completed thread history through actor events and projected replay", async () => {
    const forkSourceThreadId = Ids.ThreadId.make("native_edge_fork_source_thread")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.createThread({ thread_id: forkSourceThreadId, workspace_id: workspaceId })
        const accepted = yield* client.startTurn({
          thread_id: forkSourceThreadId,
          workspace_id: workspaceId,
          content: "fork me",
        })
        const source = yield* client.openThread(forkSourceThreadId)
        const terminal = source.events.find((event): event is Event.TurnCompleted => event.type === "turn.completed")
        const forked = yield* client.forkThread(forkSourceThreadId, {
          at_turn: terminal?.turn_id,
          title_text: "fork title",
        })
        const opened = yield* client.openThread(forked.thread_id)
        const listed = yield* client.listThreads({ workspace_id: workspaceId })
        return { accepted, terminal, forked, opened, listed }
      }).pipe(Effect.provide(edgeLayer)),
    )

    const created = result.opened.events.find((event): event is Event.ThreadCreated => event.type === "thread.created")
    const forkMessage = result.opened.events.find(
      (event): event is Event.MessageAdded => event.type === "message.added",
    )
    expect(result.terminal).toBeDefined()
    expect(result.forked.thread_id).not.toBe(forkSourceThreadId)
    expect(result.forked.title_text).toBe("fork title")
    expect(result.opened.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(result.opened.events.every((event) => event.thread_id === result.forked.thread_id)).toBe(true)
    expect(created?.data).toMatchObject({
      workspace_id: workspaceId,
      user_id: Ids.UserId.make("local-native-edge"),
      title_text: "fork title",
      forked_from: { thread_id: forkSourceThreadId, sequence: result.terminal?.sequence },
    })
    expect(forkMessage?.data.message.thread_id).toBe(result.forked.thread_id)
    expect(result.listed.map((summary) => summary.thread_id)).toContain(result.forked.thread_id)
    expect(result.accepted.accepted).toBe(true)
  })

  test("returns conflict when forking an open source turn", async () => {
    const openForkThreadId = Ids.ThreadId.make("native_edge_open_fork_source")
    const sharedThreads: ThreadEventMap = new Map([
      [
        openForkThreadId,
        [
          threadCreatedForUser(openForkThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
          turnStartedFor(openForkThreadId, 2, Common.TimestampMillis.make(11), ownerUserId),
        ],
      ],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: `user:${ownerUserId}:secret`,
            fetch: fetchFrom(edge),
          }),
        )
        return yield* client.forkThread(openForkThreadId).pipe(Effect.flip)
      }).pipe(Effect.provide(edgeLayerForToken(`user:${ownerUserId}:secret`, sharedThreads))),
    )

    expect(result).toMatchObject({ status: 409 })
  })

  test("limits SDK preview to the actor event tail", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.createThread({ thread_id: threadId, workspace_id: workspaceId })
        yield* client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "preview me" })
        return yield* client.previewThread(threadId, { limit: 2 })
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.events.map((event) => event.type)).toEqual(["message.added", "turn.completed"])
  })

  test("derives actor replay context tokens from the first terminal turn event", async () => {
    const tokenThreadId = Ids.ThreadId.make("native_edge_context_token_thread")
    const sharedThreads: ThreadEventMap = new Map()
    const ownerToken = `user:${ownerUserId}:secret`
    sharedThreads.set(tokenThreadId, [
      threadCreatedForUser(tokenThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(100)),
      turnStartedFor(tokenThreadId, 2, Common.TimestampMillis.make(101), ownerUserId),
      turnCompletedFor(tokenThreadId, 3, Common.TimestampMillis.make(102), 42),
      turnCompletedFor(tokenThreadId, 4, Common.TimestampMillis.make(103), 99),
    ])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: ownerToken,
            fetch: fetchFrom(edge),
          }),
        )
        return yield* client.openThread(tokenThreadId)
      }).pipe(Effect.provide(edgeLayerForToken(ownerToken, sharedThreads))),
    )

    expect(result.summary.context_tokens).toBe(42)
  })

  test("derives actor replay terminal status from the first terminal turn event", async () => {
    const statusThreadId = Ids.ThreadId.make("native_edge_terminal_status_thread")
    const sharedThreads: ThreadEventMap = new Map()
    const ownerToken = `user:${ownerUserId}:secret`
    sharedThreads.set(statusThreadId, [
      threadCreatedForUser(statusThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(100)),
      turnStartedFor(statusThreadId, 2, Common.TimestampMillis.make(101), ownerUserId),
      turnFailedFor(statusThreadId, 3, Common.TimestampMillis.make(102)),
      turnCompletedFor(statusThreadId, 4, Common.TimestampMillis.make(103), 99),
    ])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: ownerToken,
            fetch: fetchFrom(edge),
          }),
        )
        return yield* client.openThread(statusThreadId)
      }).pipe(Effect.provide(edgeLayerForToken(ownerToken, sharedThreads))),
    )

    expect(result.summary.active_turn_status).toBe("failed")
    expect(result.summary.context_tokens).toBeUndefined()
  })

  test("lists actor-created threads from the projection read model", async () => {
    const secondThreadId = Ids.ThreadId.make("native_edge_second_thread")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.createThread({ thread_id: threadId, workspace_id: workspaceId })
        yield* client.createThread({ thread_id: secondThreadId, workspace_id: workspaceId })
        yield* client.startTurn({ thread_id: secondThreadId, workspace_id: workspaceId, content: "newer thread" })
        const listed = yield* client.listThreads({ workspace_id: workspaceId })
        const limited = yield* client.listThreads({ workspace_id: workspaceId, limit: 1 })
        return { listed, limited }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.listed.map((summary) => summary.thread_id)).toEqual([secondThreadId, threadId])
    expect(result.listed[0]?.latest_message_text).toBe("native edge response")
    expect(result.limited.map((summary) => summary.thread_id)).toEqual([secondThreadId])
  })

  test("rebuilds native edge thread lists from mirrored actor events", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "rebuild me" })
        yield* ThreadProjection.clear()
        yield* ThreadProjection.rebuild()
        return yield* client.listThreads({ workspace_id: workspaceId })
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.map((summary) => summary.thread_id)).toEqual([threadId])
    expect(result[0]?.latest_message_text).toBe("native edge response")
  })

  test("discovers observed actor-owned threads without projection candidates", async () => {
    const actorOnlyThreadId = Ids.ThreadId.make("native_edge_actor_only_thread")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.startTurn({
          thread_id: actorOnlyThreadId,
          workspace_id: workspaceId,
          content: "actor only needle",
        })
        yield* ThreadProjection.clear()
        const listed = yield* client.listThreads({ workspace_id: workspaceId })
        const searched = yield* client.searchThreads({ workspace_id: workspaceId, query: "needle" })
        return { listed, searched }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.listed.map((summary) => summary.thread_id)).toEqual([actorOnlyThreadId])
    expect(result.searched.map((item) => item.summary.thread_id)).toEqual([actorOnlyThreadId])
  })

  test("discovers actor-only threads after opening them without projection candidates", async () => {
    const openedActorOnlyThreadId = Ids.ThreadId.make("native_edge_opened_actor_only_thread")
    const sharedThreads: ThreadEventMap = new Map([
      [
        openedActorOnlyThreadId,
        [
          threadCreatedForUser(openedActorOnlyThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
          messageAddedFor(openedActorOnlyThreadId, 2, Common.TimestampMillis.make(11), "opened actor needle"),
        ],
      ],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadProjection.clear()
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        const opened = yield* client.openThread(openedActorOnlyThreadId)
        const listed = yield* client.listThreads({ workspace_id: workspaceId })
        const searched = yield* client.searchThreads({ workspace_id: workspaceId, query: "opened" })
        return { opened, listed, searched }
      }).pipe(Effect.provide(edgeLayerForToken("secret", sharedThreads))),
    )

    expect(result.opened.summary.thread_id).toBe(openedActorOnlyThreadId)
    expect(result.listed.map((summary) => summary.thread_id)).toEqual([openedActorOnlyThreadId])
    expect(result.searched.map((item) => item.summary.thread_id)).toEqual([openedActorOnlyThreadId])
  })

  test("discovers pre-existing actor threads after starting new turns without projection candidates", async () => {
    const preExistingActorThreadId = Ids.ThreadId.make("native_edge_pre_existing_actor_thread")
    const sharedThreads: ThreadEventMap = new Map([
      [
        preExistingActorThreadId,
        [
          threadCreatedForUser(preExistingActorThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
          messageAddedFor(preExistingActorThreadId, 2, Common.TimestampMillis.make(11), "original actor needle"),
        ],
      ],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadProjection.clear()
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.startTurn({ thread_id: preExistingActorThreadId, content: "followup actor turn" })
        const listed = yield* client.listThreads({ workspace_id: workspaceId })
        const searched = yield* client.searchThreads({ workspace_id: workspaceId, query: "original" })
        return { listed, searched }
      }).pipe(Effect.provide(edgeLayerForToken("secret", sharedThreads))),
    )

    expect(result.listed.map((summary) => summary.thread_id)).toEqual([preExistingActorThreadId])
    expect(result.searched.map((item) => item.summary.thread_id)).toEqual([preExistingActorThreadId])
  })

  test("orders user-scoped lists by actor-refreshed summaries before limiting", async () => {
    const actorNewerThreadId = Ids.ThreadId.make("native_edge_actor_newer_thread")
    const projectionNewerThreadId = Ids.ThreadId.make("native_edge_projection_newer_thread")
    const sharedThreads: ThreadEventMap = new Map([
      [
        actorNewerThreadId,
        [
          threadCreatedForUser(actorNewerThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
          messageAddedFor(actorNewerThreadId, 2, Common.TimestampMillis.make(30), "actor newer"),
        ],
      ],
      [
        projectionNewerThreadId,
        [threadCreatedForUser(projectionNewerThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(20))],
      ],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadProjection.apply(
          threadCreatedForUser(actorNewerThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
        )
        yield* ThreadProjection.apply(
          threadCreatedForUser(projectionNewerThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(20)),
        )
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: `user:${ownerUserId}:secret`,
            fetch: fetchFrom(edge),
          }),
        )
        return yield* client.listThreads({ workspace_id: workspaceId, limit: 1 })
      }).pipe(Effect.provide(edgeLayerForToken(`user:${ownerUserId}:secret`, sharedThreads))),
    )

    expect(result.map((summary) => summary.thread_id)).toEqual([actorNewerThreadId])
  })

  test("searches projected native thread events", async () => {
    const matchingThreadId = Ids.ThreadId.make("native_edge_search_match")
    const otherThreadId = Ids.ThreadId.make("native_edge_search_other")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.startTurn({ thread_id: matchingThreadId, workspace_id: workspaceId, content: "find needle" })
        yield* client.startTurn({ thread_id: otherThreadId, workspace_id: workspaceId, content: "plain hay" })
        return yield* client.searchThreads({ workspace_id: workspaceId, query: "needle" })
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.map((item) => item.summary.thread_id)).toEqual([matchingThreadId])
    expect(result[0]?.score).toBeGreaterThan(0)
    expect(result[0]?.matched.some((match) => match.includes("needle"))).toBe(true)
  })

  test("honors project and file search filters without broadening results", async () => {
    const searchThreadId = Ids.ThreadId.make("native_edge_filtered_search")
    const otherProjectThreadId = Ids.ThreadId.make("native_edge_filtered_search_other")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const project = yield* ProjectStore.create({
          name: "backend",
          repo_origin: "https://github.com/example/backend.git",
        })
        const projectWorkspaceId = Ids.WorkspaceId.make(`project:${project.project_id}`)
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.startTurn({
          thread_id: searchThreadId,
          workspace_id: projectWorkspaceId,
          content: "find filter needle",
        })
        yield* client.startTurn({
          thread_id: otherProjectThreadId,
          workspace_id: workspaceId,
          content: "find filter needle",
        })
        const projectSearch = yield* client.searchThreads({ query: "project:backend needle" })
        const projectConflict = yield* client.searchThreads({
          workspace_id: workspaceId,
          query: "project:backend needle",
        })
        const missingProject = yield* client.searchThreads({
          query: "project:missing needle",
        })
        const missingFile = yield* client.searchThreads({ workspace_id: projectWorkspaceId, query: "file:missing.ts" })
        return { projectSearch, projectConflict, missingProject, missingFile }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.projectSearch.map((item) => item.summary.thread_id)).toEqual([searchThreadId])
    expect(result.projectConflict).toEqual([])
    expect(result.missingProject).toEqual([])
    expect(result.missingFile).toEqual([])
  })

  test("filters SDK thread search through verified user visibility", async () => {
    const ownerThreadId = Ids.ThreadId.make("native_edge_owner_search_thread")
    const otherThreadId = Ids.ThreadId.make("native_edge_other_search_thread")
    const sharedThreads: ThreadEventMap = new Map([
      [
        ownerThreadId,
        [
          threadCreatedForUser(ownerThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
          messageAddedFor(ownerThreadId, 2, Common.TimestampMillis.make(11), "shared needle owner"),
        ],
      ],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadEventLog.appendAndProject(
          threadCreatedForUser(ownerThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
        )
        yield* ThreadEventLog.appendAndProject(
          messageAddedFor(ownerThreadId, 2, Common.TimestampMillis.make(11), "shared needle owner"),
        )
        yield* ThreadEventLog.appendAndProject(
          threadCreatedForUser(otherThreadId, workspaceId, otherUserId, Common.TimestampMillis.make(20)),
        )
        yield* ThreadEventLog.appendAndProject(
          messageAddedFor(otherThreadId, 2, Common.TimestampMillis.make(21), "shared needle other"),
        )
        const edge = yield* NativeEdge.Service
        const ownerClient = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: `user:${ownerUserId}:secret`,
            fetch: fetchFrom(edge),
          }),
        )
        const visible = yield* ownerClient.searchThreads({ workspace_id: workspaceId, query: "needle" })
        const forged = yield* ownerClient
          .searchThreads({ workspace_id: workspaceId, query: "needle", user_id: otherUserId })
          .pipe(Effect.flip)
        return { visible, forged }
      }).pipe(Effect.provide(edgeLayerForToken(`user:${ownerUserId}:secret`, sharedThreads))),
    )

    expect(result.visible.map((item) => item.summary.thread_id)).toEqual([ownerThreadId])
    expect(result.forged).toMatchObject({ status: 403 })
  })

  test("uses actor visibility when projection visibility is stale", async () => {
    const staleThreadId = Ids.ThreadId.make("native_edge_stale_projection_thread")
    const sharedThreads: ThreadEventMap = new Map([
      [staleThreadId, [threadCreatedForUser(staleThreadId, workspaceId, otherUserId, Common.TimestampMillis.make(10))]],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* WorkspaceStore.putMembership(membership(ownerUserId, "member", workspaceId))
        yield* ThreadEventLog.appendAndProject(
          threadCreatedForUser(staleThreadId, workspaceId, otherUserId, Common.TimestampMillis.make(10)),
        )
        yield* ThreadEventLog.appendAndProject(
          threadVisibilitySetFor(staleThreadId, 2, Common.TimestampMillis.make(11), "workspace"),
        )
        yield* ThreadEventLog.appendAndProject(
          messageAddedFor(staleThreadId, 3, Common.TimestampMillis.make(12), "stale needle"),
        )
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: `user:${ownerUserId}:secret`,
            fetch: fetchFrom(edge),
          }),
        )
        const listed = yield* client.listThreads({ workspace_id: workspaceId })
        const searched = yield* client.searchThreads({ workspace_id: workspaceId, query: "needle" })
        return { listed, searched }
      }).pipe(Effect.provide(edgeLayerForToken(`user:${ownerUserId}:secret`, sharedThreads))),
    )

    expect(result.listed.map((summary) => summary.thread_id)).not.toContain(staleThreadId)
    expect(result.searched.map((item) => item.summary.thread_id)).not.toContain(staleThreadId)
  })

  test("uses actor archive state for user-scoped lists when projection state is stale", async () => {
    const actorActiveThreadId = Ids.ThreadId.make("native_edge_actor_active_list_thread")
    const sharedThreads: ThreadEventMap = new Map([
      [
        actorActiveThreadId,
        [threadCreatedForUser(actorActiveThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10))],
      ],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadProjection.apply(
          threadCreatedForUser(actorActiveThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
        )
        yield* ThreadProjection.apply(threadArchivedFor(actorActiveThreadId, 2, Common.TimestampMillis.make(11)))
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: `user:${ownerUserId}:secret`,
            fetch: fetchFrom(edge),
          }),
        )
        return yield* client.listThreads({ workspace_id: workspaceId })
      }).pipe(Effect.provide(edgeLayerForToken(`user:${ownerUserId}:secret`, sharedThreads))),
    )

    expect(result.map((summary) => summary.thread_id)).toEqual([actorActiveThreadId])
  })

  test("reapplies search filters after actor summary refresh", async () => {
    const staleArchiveThreadId = Ids.ThreadId.make("native_edge_stale_archive_search_thread")
    const sharedThreads: ThreadEventMap = new Map([
      [
        staleArchiveThreadId,
        [
          threadCreatedForUser(staleArchiveThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
          threadArchivedFor(staleArchiveThreadId, 2, Common.TimestampMillis.make(11)),
          messageAddedFor(staleArchiveThreadId, 3, Common.TimestampMillis.make(12), "archived needle"),
        ],
      ],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadProjection.apply(
          threadCreatedForUser(staleArchiveThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
        )
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: `user:${ownerUserId}:secret`,
            fetch: fetchFrom(edge),
          }),
        )
        const defaultSearch = yield* client.searchThreads({ workspace_id: workspaceId, query: "needle" })
        const archivedSearch = yield* client.searchThreads({
          workspace_id: workspaceId,
          query: "needle",
          include_archived: true,
        })
        return { defaultSearch, archivedSearch }
      }).pipe(Effect.provide(edgeLayerForToken(`user:${ownerUserId}:secret`, sharedThreads))),
    )

    expect(result.defaultSearch.map((item) => item.summary.thread_id)).not.toContain(staleArchiveThreadId)
    expect(result.archivedSearch.map((item) => item.summary.thread_id)).toEqual([staleArchiveThreadId])
  })

  test("reapplies file search filters after actor event refresh", async () => {
    const staleFileThreadId = Ids.ThreadId.make("native_edge_stale_file_search_thread")
    const sharedThreads: ThreadEventMap = new Map([
      [
        staleFileThreadId,
        [
          threadCreatedForUser(staleFileThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
          messageAddedFor(staleFileThreadId, 2, Common.TimestampMillis.make(12), "file needle"),
        ],
      ],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadProjection.apply(
          threadCreatedForUser(staleFileThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
        )
        yield* ThreadProjection.apply(toolRequestedFor(staleFileThreadId, 2, Common.TimestampMillis.make(11), "old.ts"))
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: `user:${ownerUserId}:secret`,
            fetch: fetchFrom(edge),
          }),
        )
        const fileOnly = yield* client.searchThreads({ workspace_id: workspaceId, query: "file:old.ts" })
        const fileAndTerm = yield* client.searchThreads({ workspace_id: workspaceId, query: "needle file:old.ts" })
        return { fileOnly, fileAndTerm }
      }).pipe(Effect.provide(edgeLayerForToken(`user:${ownerUserId}:secret`, sharedThreads))),
    )

    expect(result.fileOnly.map((item) => item.summary.thread_id)).not.toContain(staleFileThreadId)
    expect(result.fileAndTerm.map((item) => item.summary.thread_id)).not.toContain(staleFileThreadId)
  })

  test("finds actor file matches when projection file rows are stale", async () => {
    const actorFileThreadId = Ids.ThreadId.make("native_edge_actor_file_search_thread")
    const projectedFileThreadId = Ids.ThreadId.make("native_edge_projected_file_search_thread")
    const sharedThreads: ThreadEventMap = new Map([
      [
        projectedFileThreadId,
        [
          threadCreatedForUser(projectedFileThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
          messageAddedFor(projectedFileThreadId, 2, Common.TimestampMillis.make(12), "stale file row"),
        ],
      ],
      [
        actorFileThreadId,
        [
          threadCreatedForUser(actorFileThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
          toolRequestedFor(actorFileThreadId, 2, Common.TimestampMillis.make(11), "new.ts"),
        ],
      ],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadProjection.apply(
          threadCreatedForUser(projectedFileThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
        )
        yield* ThreadProjection.apply(
          toolRequestedFor(projectedFileThreadId, 2, Common.TimestampMillis.make(11), "new.ts"),
        )
        yield* ThreadProjection.apply(
          threadCreatedForUser(actorFileThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
        )
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: `user:${ownerUserId}:secret`,
            fetch: fetchFrom(edge),
          }),
        )
        return yield* client.searchThreads({ workspace_id: workspaceId, query: "file:new.ts" })
      }).pipe(Effect.provide(edgeLayerForToken(`user:${ownerUserId}:secret`, sharedThreads))),
    )

    expect(result.map((item) => item.summary.thread_id)).toEqual([actorFileThreadId])
  })

  test("uses actor summary filters when projection state is stale", async () => {
    const actorActiveThreadId = Ids.ThreadId.make("native_edge_actor_active_search_thread")
    const sharedThreads: ThreadEventMap = new Map([
      [
        actorActiveThreadId,
        [
          threadCreatedForUser(actorActiveThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
          messageAddedFor(actorActiveThreadId, 2, Common.TimestampMillis.make(12), "active needle"),
        ],
      ],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadProjection.apply(
          threadCreatedForUser(actorActiveThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
        )
        yield* ThreadProjection.apply(threadArchivedFor(actorActiveThreadId, 2, Common.TimestampMillis.make(11)))
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: `user:${ownerUserId}:secret`,
            fetch: fetchFrom(edge),
          }),
        )
        return yield* client.searchThreads({ workspace_id: workspaceId, query: "needle" })
      }).pipe(Effect.provide(edgeLayerForToken(`user:${ownerUserId}:secret`, sharedThreads))),
    )

    expect(result.map((item) => item.summary.thread_id)).toEqual([actorActiveThreadId])
  })

  test("preserves actor diff stats in user-scoped list and search results", async () => {
    const actorDiffThreadId = Ids.ThreadId.make("native_edge_actor_diff_summary_thread")
    const sharedThreads: ThreadEventMap = new Map([
      [
        actorDiffThreadId,
        [
          threadCreatedForUser(actorDiffThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
          messageAddedFor(actorDiffThreadId, 2, Common.TimestampMillis.make(12), "diff needle"),
          toolCompletedFor(
            actorDiffThreadId,
            3,
            Common.TimestampMillis.make(13),
            "packages/rivet-host/src/native-edge.ts",
          ),
        ],
      ],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadProjection.apply(
          threadCreatedForUser(actorDiffThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
        )
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: `user:${ownerUserId}:secret`,
            fetch: fetchFrom(edge),
          }),
        )
        const listed = yield* client.listThreads({ workspace_id: workspaceId })
        const searched = yield* client.searchThreads({ workspace_id: workspaceId, query: "needle" })
        return { listed, searched }
      }).pipe(Effect.provide(edgeLayerForToken(`user:${ownerUserId}:secret`, sharedThreads))),
    )

    expect(result.listed.find((summary) => summary.thread_id === actorDiffThreadId)?.diff).toEqual({
      additions: 3,
      modifications: 1,
      deletions: 1,
    })
    expect(result.searched.find((item) => item.summary.thread_id === actorDiffThreadId)?.summary.diff).toEqual({
      additions: 3,
      modifications: 1,
      deletions: 1,
    })
  })

  test("keeps mirroring asynchronous turn events after start accepts", async () => {
    const asyncThreadId = Ids.ThreadId.make("native_edge_async_thread")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: "secret",
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.startTurn({
          thread_id: asyncThreadId,
          workspace_id: workspaceId,
          content: "defer turn events",
        })
        return yield* waitForProjectedLatest(client, asyncThreadId)
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.latest_message_text).toBe("native edge response")
    expect(result.active_turn_status).toBe("completed")
  })

  test("filters SDK thread lists through verified user visibility", async () => {
    const ownerThreadId = Ids.ThreadId.make("native_edge_owner_thread")
    const otherThreadId = Ids.ThreadId.make("native_edge_other_thread")
    const sharedThreads: ThreadEventMap = new Map([
      [ownerThreadId, [threadCreatedForUser(ownerThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10))]],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadProjection.apply(
          threadCreatedForUser(ownerThreadId, workspaceId, ownerUserId, Common.TimestampMillis.make(10)),
        )
        yield* ThreadProjection.apply(
          threadCreatedForUser(otherThreadId, workspaceId, otherUserId, Common.TimestampMillis.make(20)),
        )
        const edge = yield* NativeEdge.Service
        const ownerClient = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: `user:${ownerUserId}:secret`,
            fetch: fetchFrom(edge),
          }),
        )
        const visible = yield* ownerClient.listThreads({ workspace_id: workspaceId })
        const forged = yield* ownerClient
          .listThreads({ workspace_id: workspaceId, user_id: otherUserId })
          .pipe(Effect.flip)
        return { visible, forged }
      }).pipe(Effect.provide(edgeLayerForToken(`user:${ownerUserId}:secret`, sharedThreads))),
    )

    expect(result.visible.map((summary) => summary.thread_id)).toEqual([ownerThreadId])
    expect(result.forged).toMatchObject({ status: 403 })
  })

  test("rejects protected routes when the bearer token is missing", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const publicHealth = yield* edge.handle(new Request("http://native-edge.test/health"))
        const create = yield* edge.handle(
          new Request("http://native-edge.test/v1/threads", {
            method: "POST",
            body: JSON.stringify(
              Codec.encode(Remote.CreateThreadRequest)({ thread_id: threadId, workspace_id: workspaceId }),
            ),
          }),
        )
        const orbs = yield* edge.handle(new Request("http://native-edge.test/v1/orbs"))
        const interrupt = yield* edge.handle(
          new Request("http://native-edge.test/v1/turns/interrupt", {
            method: "POST",
            body: JSON.stringify(Codec.encode(Remote.InterruptTurnRequest)({ thread_id: threadId, turn_id: turnId })),
          }),
        )
        return { publicHealth, create, orbs, interrupt }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.publicHealth.status).toBe(200)
    expect(await result.publicHealth.json()).toEqual({ status: "ok" })
    expect(result.create.status).toBe(401)
    expect(result.orbs.status).toBe(401)
    expect(result.interrupt.status).toBe(401)
  })

  test("rejects replay and presence for missing threads and unverified user identity", async () => {
    const ownerToken = `user:${ownerUserId}:secret`
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const missing = yield* edge.handle(
          new Request("http://native-edge.test/v1/threads/missing_native_edge_thread/events", {
            headers: { authorization: `Bearer ${ownerToken}` },
          }),
        )
        const missingPresence = yield* edge.handle(
          new Request("http://native-edge.test/v1/threads/missing_native_edge_thread/presence", {
            method: "POST",
            headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
            body: JSON.stringify(Codec.encode(Remote.PresenceRequest)({ user_id: ownerUserId, state: "active" })),
          }),
        )
        const forged = yield* edge.handle(
          new Request(`http://native-edge.test/v1/threads/${threadId}/events?user_id=forged_user`, {
            headers: { authorization: `Bearer ${ownerToken}` },
          }),
        )
        const missingArtifacts = yield* edge.handle(
          new Request("http://native-edge.test/v1/artifacts?thread_id=missing_native_edge_thread", {
            headers: { authorization: `Bearer ${ownerToken}` },
          }),
        )
        const missingThreadId = yield* edge.handle(
          new Request("http://native-edge.test/v1/artifacts", {
            headers: { authorization: `Bearer ${ownerToken}` },
          }),
        )
        const missingArtifact = yield* edge.handle(
          new Request("http://native-edge.test/v1/artifacts/missing_native_edge_artifact", {
            headers: { authorization: `Bearer ${ownerToken}` },
          }),
        )
        const forgedArtifacts = yield* edge.handle(
          new Request(`http://native-edge.test/v1/artifacts?thread_id=${threadId}&user_id=forged_user`, {
            headers: { authorization: `Bearer ${ownerToken}` },
          }),
        )
        return { missing, missingPresence, forged, missingArtifacts, missingThreadId, missingArtifact, forgedArtifacts }
      }).pipe(Effect.provide(edgeLayerForToken(ownerToken, new Map()))),
    )

    expect(result.missing.status).toBe(404)
    expect(result.missing.headers.get("content-type")).toBe("application/json")
    expect(result.missingPresence.status).toBe(404)
    expect(result.forged.status).toBe(403)
    expect(result.missingArtifacts.status).toBe(404)
    expect(result.missingThreadId.status).toBe(400)
    expect(result.missingArtifact.status).toBe(404)
    expect(result.forgedArtifacts.status).toBe(403)
  })

  test("rejects thread export, reference, compact, and fork for unverified user identity", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        yield* edge.handle(
          new Request("http://native-edge.test/v1/threads", {
            method: "POST",
            headers: { ...authorizedHeaders, "content-type": "application/json" },
            body: JSON.stringify(
              Codec.encode(Remote.CreateThreadRequest)({ thread_id: threadId, workspace_id: workspaceId }),
            ),
          }),
        )
        const share = yield* edge.handle(
          new Request(`http://native-edge.test/v1/threads/${threadId}/share?user_id=forged_user`, {
            headers: authorizedHeaders,
          }),
        )
        const reference = yield* edge.handle(
          new Request(`http://native-edge.test/v1/threads/${threadId}/reference?user_id=forged_user`, {
            headers: authorizedHeaders,
          }),
        )
        const compact = yield* edge.handle(
          new Request(`http://native-edge.test/v1/threads/${threadId}/compact?user_id=forged_user`, {
            method: "POST",
            headers: authorizedHeaders,
          }),
        )
        const fork = yield* edge.handle(
          new Request(`http://native-edge.test/v1/threads/${threadId}/fork`, {
            method: "POST",
            headers: { ...authorizedHeaders, "content-type": "application/json" },
            body: JSON.stringify(
              Codec.encode(Remote.ForkThreadRequest)({ thread_id: threadId, user_id: Ids.UserId.make("forged_user") }),
            ),
          }),
        )
        const mismatch = yield* edge.handle(
          new Request(`http://native-edge.test/v1/threads/${threadId}/fork`, {
            method: "POST",
            headers: { ...authorizedHeaders, "content-type": "application/json" },
            body: JSON.stringify(
              Codec.encode(Remote.ForkThreadRequest)({
                thread_id: Ids.ThreadId.make("native_edge_fork_mismatch"),
              }),
            ),
          }),
        )
        return { share, reference, compact, fork, mismatch }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.share.status).toBe(403)
    expect(result.reference.status).toBe(403)
    expect(result.compact.status).toBe(403)
    expect(result.fork.status).toBe(403)
    expect(result.mismatch.status).toBe(400)
  })

  test("denies thread export, reference, compact, and fork to verified outsiders for private owner threads", async () => {
    const securedThreadId = Ids.ThreadId.make("native_edge_secured_reference_thread")
    const sharedThreads: ThreadEventMap = new Map()
    const ownerToken = `user:${ownerUserId}:secret`
    const otherToken = `user:${otherUserId}:secret`
    await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: ownerToken,
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.createThread({ thread_id: securedThreadId, workspace_id: workspaceId })
      }).pipe(Effect.provide(edgeLayerForToken(ownerToken, sharedThreads))),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: otherToken,
            fetch: fetchFrom(edge),
          }),
        )
        const share = yield* client.shareThread(securedThreadId).pipe(Effect.flip)
        const reference = yield* client.referenceThread({ thread_id: securedThreadId }).pipe(Effect.flip)
        const compact = yield* client.compactThread(securedThreadId).pipe(Effect.flip)
        const fork = yield* client.forkThread(securedThreadId).pipe(Effect.flip)
        return { share, reference, compact, fork }
      }).pipe(Effect.provide(edgeLayerForToken(otherToken, sharedThreads))),
    )

    expect(result.share).toMatchObject({ status: 403 })
    expect(result.reference).toMatchObject({ status: 403 })
    expect(result.compact).toMatchObject({ status: 403 })
    expect(result.fork).toMatchObject({ status: 403 })
    expect(sharedThreads.get(securedThreadId)?.map((event) => event.type)).not.toContain("context.compacted")
  })

  test("builds Bun serve options with idle timeout disabled", () => {
    const options = NativeEdge.serveOptions({
      hostname: "127.0.0.1",
      port: 12345,
      fetch: () => new Response("ok"),
    })

    expect(options).toMatchObject({ hostname: "127.0.0.1", port: 12345, idleTimeout: 0 })
  })

  test("uses serve-time tokens and refuses tokenless non-loopback binds", async () => {
    const resolved = NativeEdge.resolveServeInput({ token: "layer-token" }, { token: "serve-token" })
    const errors = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const tokenless = yield* edge.serve({ hostname: "0.0.0.0" }).pipe(Effect.flip)
        const genericToken = yield* edge.serve({ hostname: "0.0.0.0", token: "serve-token" }).pipe(Effect.flip)
        return { tokenless, genericToken }
      }).pipe(Effect.provide(edgeLayerWithoutToken)),
    )

    expect(resolved.requiredToken).toBe("serve-token")
    expect(errors.tokenless).toMatchObject({ operation: "serve", status: 400 })
    expect(errors.genericToken).toMatchObject({
      operation: "serve",
      status: 400,
      message: "refusing to bind non-loopback host without a user-scoped token",
    })
  })

  test("sets thread visibility through actor events and projected lists", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        yield* edge.handle(
          new Request("http://native-edge.test/v1/threads", {
            method: "POST",
            headers: { ...authorizedHeaders, "content-type": "application/json" },
            body: JSON.stringify(
              Codec.encode(Remote.CreateThreadRequest)({ thread_id: threadId, workspace_id: workspaceId }),
            ),
          }),
        )
        const visibility = yield* edge.handle(
          new Request(`http://native-edge.test/v1/threads/${threadId}/visibility`, {
            method: "POST",
            headers: { ...authorizedHeaders, "content-type": "application/json" },
            body: JSON.stringify(Codec.encode(Remote.SetThreadVisibilityBody)({ visibility: "unlisted" })),
          }),
        )
        const opened = yield* edge.handle(
          new Request(`http://native-edge.test/v1/threads/${threadId}`, { headers: authorizedHeaders }),
        )
        const listed = yield* edge.handle(
          new Request(`http://native-edge.test/v1/threads?workspace_id=${workspaceId}`, { headers: authorizedHeaders }),
        )
        return { visibility, opened, listed }
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(result.visibility.status).toBe(200)
    const visibility = Schema.decodeUnknownSync(Remote.ThreadSummary)(await result.visibility.json())
    const opened = Schema.decodeUnknownSync(Remote.ThreadRecord)(await result.opened.json())
    const listed = Schema.decodeUnknownSync(Schema.Array(Remote.ThreadSummary))(await result.listed.json())

    expect(visibility.visibility).toBe("unlisted")
    expect(opened.events.map((event) => event.type)).toEqual(["thread.created", "thread.visibility.set"])
    expect(opened.summary.visibility).toBe("unlisted")
    expect(listed.find((summary) => summary.thread_id === threadId)?.visibility).toBe("unlisted")
  })

  test("returns not found when setting visibility on a missing actor thread", async () => {
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        return yield* edge.handle(
          new Request("http://native-edge.test/v1/threads/missing_native_edge_thread/visibility", {
            method: "POST",
            headers: { ...authorizedHeaders, "content-type": "application/json" },
            body: JSON.stringify(Codec.encode(Remote.SetThreadVisibilityBody)({ visibility: "workspace" })),
          }),
        )
      }).pipe(Effect.provide(edgeLayer)),
    )

    expect(response.status).toBe(404)
  })

  test("requires verified writer identity when setting visibility", async () => {
    const securedVisibilityThreadId = Ids.ThreadId.make("native_edge_secured_visibility_thread")
    const sharedThreads: ThreadEventMap = new Map()
    const ownerToken = `user:${ownerUserId}:secret`
    const otherToken = `user:${otherUserId}:secret`
    const ownerResult = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        const client = Client.make(
          Client.fetchTransport({
            base_url: "http://native-edge.test",
            token: ownerToken,
            fetch: fetchFrom(edge),
          }),
        )
        yield* client.createThread({ thread_id: securedVisibilityThreadId, workspace_id: workspaceId })
        return yield* client.setThreadVisibility(securedVisibilityThreadId, "unlisted")
      }).pipe(Effect.provide(edgeLayerForToken(ownerToken, sharedThreads))),
    )
    const outsider = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        return yield* edge.handle(
          new Request(`http://native-edge.test/v1/threads/${securedVisibilityThreadId}/visibility`, {
            method: "POST",
            headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
            body: JSON.stringify(Codec.encode(Remote.SetThreadVisibilityBody)({ visibility: "private" })),
          }),
        )
      }).pipe(Effect.provide(edgeLayerForToken(otherToken, sharedThreads))),
    )

    expect(ownerResult.visibility).toBe("unlisted")
    expect(outsider.status).toBe(403)
  })

  test("serves orb changes only in orb mode", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const disabled = yield* NativeEdge.Service.pipe(
          Effect.flatMap((edge) =>
            edge.handle(new Request("http://native-edge.test/v1/orb/changes", { headers: authorizedHeaders })),
          ),
          Effect.provide(edgeLayer),
        )
        const edge = yield* NativeEdge.Service
        const unauthorized = yield* edge.handle(new Request("http://native-edge.test/v1/orb/changes"))
        const enabled = yield* edge.handle(
          new Request("http://native-edge.test/v1/orb/changes", { headers: authorizedHeaders }),
        )
        const threadRoute = yield* edge.handle(
          new Request("http://native-edge.test/v1/threads", {
            method: "POST",
            headers: { ...authorizedHeaders, "content-type": "application/json" },
            body: JSON.stringify(
              Codec.encode(Remote.CreateThreadRequest)({ thread_id: threadId, workspace_id: workspaceId }),
            ),
          }),
        )
        return { disabled, unauthorized, enabled, threadRoute }
      }).pipe(Effect.provide(orbEdgeLayer)),
    )

    const body = Schema.decodeUnknownSync(Remote.OrbChangesResponse)(await result.enabled.json())

    expect(result.disabled.status).toBe(404)
    expect(result.unauthorized.status).toBe(401)
    expect(result.enabled.status).toBe(200)
    expect(result.threadRoute.status).toBe(404)
    expect(body).toEqual({
      base_commit: "base123",
      head_commit: "head456",
      diff: "workspace:/workspace/orb\n",
      dirty: true,
    })
  })

  test("serves read-only orb files only in orb mode", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const disabled = yield* NativeEdge.Service.pipe(
          Effect.flatMap((edge) =>
            edge.handle(new Request("http://native-edge.test/v1/orb/files", { headers: authorizedHeaders })),
          ),
          Effect.provide(edgeLayer),
        )
        const edge = yield* NativeEdge.Service
        const listed = yield* edge.handle(
          new Request("http://native-edge.test/v1/orb/files?path=src", { headers: authorizedHeaders }),
        )
        const opened = yield* edge.handle(
          new Request("http://native-edge.test/v1/orb/file?path=README.md", { headers: authorizedHeaders }),
        )
        const invalid = yield* edge.handle(
          new Request("http://native-edge.test/v1/orb/file?path=..%2Fsecret.txt", { headers: authorizedHeaders }),
        )
        const missing = yield* edge.handle(
          new Request("http://native-edge.test/v1/orb/file?path=missing.txt", { headers: authorizedHeaders }),
        )
        const noPath = yield* edge.handle(
          new Request("http://native-edge.test/v1/orb/file", { headers: authorizedHeaders }),
        )
        return { disabled, listed, opened, invalid, missing, noPath }
      }).pipe(Effect.provide(orbEdgeLayer)),
    )

    const files = Schema.decodeUnknownSync(Remote.OrbFilesResponse)(await result.listed.json())
    const file = Schema.decodeUnknownSync(Remote.OrbFileResponse)(await result.opened.json())

    expect(result.disabled.status).toBe(404)
    expect(result.listed.status).toBe(200)
    expect(result.opened.status).toBe(200)
    expect(result.invalid.status).toBe(400)
    expect(result.missing.status).toBe(404)
    expect(result.noPath.status).toBe(400)
    expect(files).toEqual({
      path: "src",
      entries: [{ name: "index.ts", path: "src/index.ts", kind: "file", size: 23 }],
    })
    expect(file).toEqual({ path: "README.md", kind: "text", content: "hello\n", truncated: false })
  })

  test("serves orb PTY websocket only in orb mode", async () => {
    const writes: Array<string> = []
    const resizes: Array<{ readonly cols: number; readonly rows: number }> = []
    const ptyLayer = OrbPty.testLayer({
      open: (input) =>
        Effect.succeed({
          write: (bytes) =>
            Effect.sync(() => {
              const text = decoder.decode(bytes)
              writes.push(text)
              return Effect.runPromise(input.onData(encoder.encode(`pty:${text}`)))
            }).pipe(Effect.asVoid),
          resize: (cols, rows) =>
            Effect.sync(() => {
              resizes.push({ cols, rows })
            }),
          close: Effect.void,
        }),
    })
    let disabled: NativeEdge.ServedEdge | undefined
    let missingPty: NativeEdge.ServedEdge | undefined
    let enabled: NativeEdge.ServedEdge | undefined

    try {
      disabled = await Effect.runPromise(
        Effect.gen(function* () {
          const edge = yield* NativeEdge.Service
          return yield* edge.serve({ port: 0, token: "secret" })
        }).pipe(Effect.provide(edgeLayer.pipe(Layer.provideMerge(ptyLayer)))),
      )
      const disabledResponse = await fetch(`${disabled.url}/v1/orb/pty?token=secret`)

      missingPty = await Effect.runPromise(
        Effect.gen(function* () {
          const edge = yield* NativeEdge.Service
          return yield* edge.serve({ port: 0, token: "secret" })
        }).pipe(Effect.provide(orbEdgeLayer)),
      )
      const missingPtyUnauthorized = await fetch(`${missingPty.url}/v1/orb/pty`)
      const missingPtyWrongToken = await fetch(`${missingPty.url}/v1/orb/pty?token=wrong`)
      const missingPtyAuthorized = await fetch(`${missingPty.url}/v1/orb/pty?token=secret`)

      enabled = await Effect.runPromise(
        Effect.gen(function* () {
          const edge = yield* NativeEdge.Service
          return yield* edge.serve({ port: 0, token: "secret" })
        }).pipe(Effect.provide(orbEdgeLayer.pipe(Layer.provideMerge(ptyLayer)))),
      )
      const unauthorized = await fetch(`${enabled.url}/v1/orb/pty`)
      const wrongToken = await fetch(`${enabled.url}/v1/orb/pty?token=wrong`)
      const socket = await connect(`${toWsUrl(enabled.url)}/v1/orb/pty?token=secret`)

      socket.send(encoder.encode("echo hi\n"))
      const first = await nextMessage(socket)
      socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 }))
      socket.send(encoder.encode("after resize\n"))
      const second = await nextMessage(socket)
      socket.close()

      expect(disabledResponse.status).toBe(404)
      expect(missingPtyUnauthorized.status).toBe(401)
      expect(missingPtyWrongToken.status).toBe(401)
      expect(missingPtyAuthorized.status).toBe(503)
      expect(unauthorized.status).toBe(401)
      expect(wrongToken.status).toBe(401)
      expect(decodeMessage(first)).toBe("pty:echo hi\n")
      expect(decodeMessage(second)).toBe("pty:after resize\n")
      expect(writes).toEqual(["echo hi\n", "after resize\n"])
      expect(resizes).toEqual([{ cols: 100, rows: 40 }])
    } finally {
      if (disabled !== undefined) await Effect.runPromise(disabled.close())
      if (missingPty !== undefined) await Effect.runPromise(missingPty.close())
      if (enabled !== undefined) await Effect.runPromise(enabled.close())
    }
  })

  test("allows non-loopback generic tokens only for orb mode", async () => {
    const handle = await Effect.runPromise(
      Effect.gen(function* () {
        const edge = yield* NativeEdge.Service
        return yield* edge.serve({ hostname: "0.0.0.0", token: "secret" })
      }).pipe(Effect.provide(orbEdgeLayer)),
    )

    try {
      expect(handle.url).toStartWith("http://0.0.0.0:")
    } finally {
      await Effect.runPromise(handle.close())
    }
  })
})

const fetchFrom = (edge: NativeEdge.Interface) => async (input: string | URL | Request, init?: RequestInit) =>
  edge
    .handle(input instanceof Request ? new Request(input, init) : new Request(input.toString(), init))
    .pipe(Effect.runPromise)

const connect = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.binaryType = "arraybuffer"
    socket.addEventListener("open", () => resolve(socket), { once: true })
    socket.addEventListener("error", () => reject(new Error(`websocket failed: ${url}`)), { once: true })
    socket.addEventListener("close", () => reject(new Error(`websocket closed before open: ${url}`)), { once: true })
  })

const nextMessage = (socket: WebSocket) =>
  new Promise<MessageEvent>((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(event), { once: true })
    socket.addEventListener("error", () => reject(new Error("websocket failed while waiting for message")), {
      once: true,
    })
  })

const decodeMessage = (event: MessageEvent) =>
  typeof event.data === "string"
    ? event.data
    : event.data instanceof ArrayBuffer
      ? decoder.decode(event.data)
      : event.data instanceof Uint8Array
        ? decoder.decode(event.data)
        : String(event.data)

const toWsUrl = (url: string) => url.replace(/^http:/, "ws:").replace(/^https:/, "wss:")

const readNdjsonLines = async (response: Response, count: number): Promise<ReadonlyArray<string>> => {
  const reader = response.body?.getReader()
  if (reader === undefined) return []
  const ndjsonDecoder = new TextDecoder()
  const lines: Array<string> = []
  let pending = ""
  while (lines.length < count) {
    const chunk = await reader.read()
    if (chunk.done) break
    pending += ndjsonDecoder.decode(chunk.value, { stream: true })
    const parts = pending.split("\n")
    pending = parts.pop() ?? ""
    for (const part of parts) {
      if (part.length > 0) lines.push(part)
      if (lines.length >= count) break
    }
  }
  await reader.cancel()
  return lines
}

const waitForProjectedLatest = (
  client: Client.Interface,
  targetThreadId: Ids.ThreadId,
): Effect.Effect<Remote.ThreadSummary, Client.SdkError> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const summaries = yield* client.listThreads({ workspace_id: workspaceId })
      const summary = summaries.find((item) => item.thread_id === targetThreadId)
      if (summary?.latest_message_text !== undefined) return summary
      yield* Effect.sleep("25 millis")
    }
    return yield* new Client.SdkError({
      message: `Thread ${targetThreadId} projection did not catch up`,
      operation: "waitForProjectedLatest",
    })
  })

const configLayer = Config.layerFromValues({
  workspace_root: testRoot,
  data_dir: join(testRoot, ".rika"),
  default_mode: "smart",
  backend_id: "native-rivet-edge-test",
})
const databaseLayer = Database.memoryLayer
const timeLayer = Time.fixedLayer(Common.TimestampMillis.make(1_900_000_000_000))
const migrationLayer = Migration.layer.pipe(Layer.provideMerge(databaseLayer))
const eventLogLayer = ThreadEventLog.layer.pipe(Layer.provideMerge(SecretRedactor.layer))
const projectionLayer = ThreadProjection.layer.pipe(Layer.provideMerge(databaseLayer))
const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
const orbStoreLayer = OrbStore.layer.pipe(
  Layer.provideMerge(databaseLayer),
  Layer.provideMerge(timeLayer),
  Layer.provideMerge(IdGenerator.sequenceLayer(1)),
)
const workspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
const projectStoreLayer = ProjectStore.layer.pipe(
  Layer.provideMerge(configLayer),
  Layer.provideMerge(databaseLayer),
  Layer.provideMerge(timeLayer),
  Layer.provideMerge(IdGenerator.sequenceLayer(1)),
)
const storageLayer = Layer.mergeAll(
  databaseLayer,
  migrationLayer,
  eventLogLayer,
  projectionLayer,
  artifactLayer,
  orbStoreLayer,
  workspaceStoreLayer,
  projectStoreLayer,
)
const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
const workspaceAccessLayer = WorkspaceAccess.layer.pipe(
  Layer.provideMerge(databaseLayer),
  Layer.provideMerge(projectionLayer),
  Layer.provideMerge(workspaceStoreLayer),
  Layer.provideMerge(timeLayer),
)

const fakeOrbManagerLayer = Layer.effect(
  OrbManager.Service,
  Effect.gen(function* () {
    const orbs = yield* OrbStore.Service
    return OrbManager.Service.of({
      provisionForThread: Effect.fn("NativeEdgeTest.orbManager.provisionForThread")(function* (
        input: OrbManager.ProvisionInput,
      ) {
        if (input.project_id === failingOrbProjectId) {
          return yield* new OrbManager.OrbProvisionError({
            message: `Project ${input.project_id} was not found`,
            step: "provisionForThread",
          })
        }
        const created = yield* orbs
          .create({ thread_id: input.thread_id, project_id: input.project_id })
          .pipe(Effect.mapError((error) => fakeOrbProvisionError(error, "provisionForThread")))
        return yield* orbs
          .setStatus(created.orb_id, "running")
          .pipe(Effect.mapError((error) => fakeOrbProvisionError(error, "provisionForThread", created.orb_id)))
      }),
      pause: Effect.fn("NativeEdgeTest.orbManager.pause")(function* (orbId: Ids.OrbId) {
        return yield* orbs
          .setStatus(orbId, "paused")
          .pipe(Effect.mapError((error) => fakeOrbProvisionError(error, "pause", orbId)))
      }),
      resume: Effect.fn("NativeEdgeTest.orbManager.resume")(function* (orbId: Ids.OrbId) {
        return yield* orbs
          .setStatus(orbId, "running")
          .pipe(Effect.mapError((error) => fakeOrbProvisionError(error, "resume", orbId)))
      }),
      kill: Effect.fn("NativeEdgeTest.orbManager.kill")(function* (orbId: Ids.OrbId) {
        return yield* orbs
          .setStatus(orbId, "killed")
          .pipe(Effect.mapError((error) => fakeOrbProvisionError(error, "kill", orbId)))
      }),
      forceKill: Effect.fn("NativeEdgeTest.orbManager.forceKill")(function* (orbId: Ids.OrbId) {
        return yield* orbs
          .setStatus(orbId, "killed")
          .pipe(Effect.mapError((error) => fakeOrbProvisionError(error, "forceKill", orbId)))
      }),
    })
  }),
)

const fakeOrbProvisionError = (error: Error, step: string, orbId?: Ids.OrbId) =>
  new OrbManager.OrbProvisionError({
    message: error.message,
    step,
    ...(orbId === undefined ? {} : { orb_id: orbId }),
  })

const testLayer = Layer.mergeAll(
  configLayer,
  timeLayer,
  IdGenerator.sequenceLayer(1),
  SecretRedactor.layer,
  Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(SecretRedactor.layer)),
  ThreadDirectory.layer,
  IdeBridge.layer,
  fakeOrbManagerLayer.pipe(Layer.provideMerge(storageLayer)),
  PresenceHub.layer.pipe(Layer.provideMerge(timeLayer)),
  storageLayer,
  migratedStorageLayer,
  workspaceAccessLayer,
)

const makeThreadClientFakeLayer = (sharedThreads?: ThreadEventMap) =>
  Layer.effect(
    ThreadClient.Service,
    Effect.gen(function* () {
      const idGenerator = yield* IdGenerator.Service
      const time = yield* Time.Service
      const workspaceAccess = yield* WorkspaceAccess.Service
      const threads = sharedThreads ?? new Map<Ids.ThreadId, Array<Event.Event>>()
      const readThread = (thread: Ids.ThreadId) => Effect.sync(() => threads.get(thread) ?? [])
      const append = (thread: Ids.ThreadId, events: ReadonlyArray<Event.Event>) =>
        Effect.sync(() => threads.set(thread, [...(threads.get(thread) ?? []), ...events]))
      return ThreadClient.Service.of({
        ensureThread: Effect.fn("NativeEdgeTest.ensureThread")(function* (input: ThreadActor.EnsureThreadPayload) {
          if (input.thread_id === postProvisionActorFailureThreadId) {
            return yield* new ThreadActor.ThreadActorActionError({
              message: `Thread ${input.thread_id} already belongs to another workspace`,
              operation: "EnsureThread",
              thread_id: input.thread_id,
            })
          }
          const existing = yield* readThread(input.thread_id)
          const existingWorkspaceId = existingThreadWorkspace(existing)
          if (existingWorkspaceId !== undefined && existingWorkspaceId !== input.workspace_id) {
            return yield* new ThreadActor.ThreadActorActionError({
              message: `Thread ${input.thread_id} already belongs to another workspace`,
              operation: "EnsureThread",
              thread_id: input.thread_id,
            })
          }
          if (existing.length === 0)
            yield* append(input.thread_id, [yield* makeThreadCreated(input, idGenerator, time)])
          return snapshot(input.thread_id, yield* readThread(input.thread_id))
        }),
        startTurn: Effect.fn("NativeEdgeTest.startTurn")(function* (input: ThreadActor.StartTurnPayload) {
          fakeStartTurnInputs.push(input)
          const existing = yield* readThread(input.thread_id)
          if (existing.length === 0) {
            yield* append(input.thread_id, [
              yield* makeThreadCreated(
                { thread_id: input.thread_id, workspace_id: input.workspace_id, ...identityInput(input.identity) },
                idGenerator,
                time,
              ),
            ])
          } else if (existingThreadWorkspace(existing) !== input.workspace_id) {
            return { thread_id: input.thread_id, accepted: true as const }
          }
          const nextSequence = (yield* readThread(input.thread_id)).at(-1)?.sequence ?? 0
          const turn = yield* makeTurnEvents(input, nextSequence, idGenerator, time)
          if (input.content === "defer turn events") {
            yield* Effect.sleep("40 millis").pipe(
              Effect.andThen(append(input.thread_id, turn)),
              Effect.forkDetach,
              Effect.asVoid,
            )
            return { thread_id: input.thread_id, accepted: true as const }
          }
          yield* append(input.thread_id, turn)
          return { thread_id: input.thread_id, accepted: true as const }
        }),
        getEvents: Effect.fn("NativeEdgeTest.getEvents")(function* (input: ThreadActor.GetEventsPayload) {
          yield* requireReadInFake(input, yield* readThread(input.thread_id), workspaceAccess)
          const afterSequence = input.after_sequence ?? 0
          return (yield* readThread(input.thread_id)).filter((event) => event.sequence > afterSequence)
        }),
        appendMirroredEvents: Effect.fn("NativeEdgeTest.appendMirroredEvents")(function* (
          input: ThreadActor.AppendMirroredEventsPayload,
        ) {
          const existing = yield* readThread(input.thread_id)
          if (existing.length > 0) yield* requireReadInFake(input, existing, workspaceAccess)
          const inserted: Array<Event.Event> = []
          let skippedCount = 0
          for (const event of input.events) {
            if (existing.some((current) => current.id === event.id || current.sequence === event.sequence)) {
              skippedCount += 1
            } else {
              inserted.push(event)
            }
          }
          yield* append(input.thread_id, inserted)
          return { inserted_events: inserted, skipped_count: skippedCount }
        }),
        subscribeEvents: (input: ThreadActor.GetEventsPayload) =>
          Stream.paginate({ ...input }, (current) =>
            Effect.gen(function* () {
              yield* requireReadInFake(current, yield* readThread(current.thread_id), workspaceAccess)
              const afterSequence = current.after_sequence ?? 0
              const events = (yield* readThread(current.thread_id)).filter((event) => event.sequence > afterSequence)
              if (events.length === 0) {
                return yield* Effect.succeed([[], Option.some(current)] as const).pipe(Effect.delay("25 millis"))
              }
              const latest = events.at(-1)
              return [
                events,
                Option.some(latest === undefined ? current : { ...current, after_sequence: latest.sequence }),
              ] as const
            }),
          ),
        replayThread: Effect.fn("NativeEdgeTest.replayThread")(function* (input: ThreadActor.ThreadIdPayload) {
          const existing = yield* readThread(input.thread_id)
          if (existing.length > 0) yield* requireReadInFake(input, existing, workspaceAccess)
          return snapshot(input.thread_id, existing)
        }),
        getSnapshot: Effect.fn("NativeEdgeTest.getSnapshot")(function* (input: ThreadActor.ThreadIdPayload) {
          const existing = yield* readThread(input.thread_id)
          if (existing.length > 0) yield* requireReadInFake(input, existing, workspaceAccess)
          return snapshot(input.thread_id, existing)
        }),
        setVisibility: Effect.fn("NativeEdgeTest.setVisibility")(function* (input: ThreadActor.SetVisibilityPayload) {
          const existing = yield* readThread(input.thread_id)
          if (existing.length === 0) {
            return yield* new ThreadActor.ThreadActorActionError({
              message: `Thread ${input.thread_id} was not found`,
              operation: "SetVisibility",
              thread_id: input.thread_id,
            })
          }
          const current = ThreadActor.stateFromEvents(input.thread_id, existing)
          const summary = fakeSummaryFromEvents(input.thread_id, existing)
          if (summary !== undefined && input.identity !== undefined) {
            yield* workspaceAccess.requireThreadSummary(summary, {
              thread_id: input.thread_id,
              user_id: input.identity.user_id,
              action: "write",
            })
          }
          if (current.visibility === input.visibility) {
            return snapshot(input.thread_id, existing)
          }
          const sequence = existing.at(-1)?.sequence ?? 0
          yield* append(input.thread_id, [yield* makeThreadVisibilitySet(input, sequence + 1, idGenerator, time)])
          return snapshot(input.thread_id, yield* readThread(input.thread_id))
        }),
        forkThread: Effect.fn("NativeEdgeTest.forkThread")(function* (input: ThreadActor.PrepareForkThreadPayload) {
          return yield* forkInFake(input, readThread, append, workspaceAccess, idGenerator)
        }),
        archiveThread: Effect.fn("NativeEdgeTest.archiveThread")(function* (input: ThreadActor.ThreadIdPayload) {
          return yield* setArchivedInFake(input, true, readThread, append, workspaceAccess, idGenerator, time)
        }),
        unarchiveThread: Effect.fn("NativeEdgeTest.unarchiveThread")(function* (input: ThreadActor.ThreadIdPayload) {
          return yield* setArchivedInFake(input, false, readThread, append, workspaceAccess, idGenerator, time)
        }),
        compactThread: Effect.fn("NativeEdgeTest.compactThread")(function* (input: ThreadActor.ThreadIdPayload) {
          return yield* compactInFake(input, readThread, append, workspaceAccess, idGenerator, time)
        }),
        interruptTurn: Effect.fn("NativeEdgeTest.interruptTurn")(function* (input: ThreadActor.InterruptTurnPayload) {
          return yield* interruptInFake(input, readThread, append, workspaceAccess, idGenerator, time)
        }),
      })
    }),
  )

const requireReadInFake = (
  input: ThreadActor.ThreadIdPayload,
  events: ReadonlyArray<Event.Event>,
  workspaceAccess: WorkspaceAccess.Interface,
) =>
  Effect.gen(function* () {
    const summary = fakeSummaryFromEvents(input.thread_id, events)
    if (summary !== undefined && input.identity !== undefined) {
      yield* workspaceAccess.requireThreadSummary(summary, {
        thread_id: input.thread_id,
        user_id: input.identity.user_id,
        action: "read",
      })
    }
  })

const compactInFake = (
  input: ThreadActor.ThreadIdPayload,
  readThread: (thread: Ids.ThreadId) => Effect.Effect<ReadonlyArray<Event.Event>>,
  append: (thread: Ids.ThreadId, events: ReadonlyArray<Event.Event>) => Effect.Effect<void>,
  workspaceAccess: WorkspaceAccess.Interface,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
) =>
  Effect.gen(function* () {
    const existing = yield* readThread(input.thread_id)
    if (existing.length === 0) {
      return yield* new ThreadActor.ThreadActorActionError({
        message: `Thread ${input.thread_id} was not found`,
        operation: "CompactThread",
        thread_id: input.thread_id,
      })
    }
    const summary = fakeSummaryFromEvents(input.thread_id, existing)
    if (summary !== undefined && input.identity !== undefined) {
      yield* workspaceAccess.requireThreadSummary(summary, {
        thread_id: input.thread_id,
        user_id: input.identity.user_id,
        action: "write",
      })
    }
    const current = ThreadActor.stateFromEvents(input.thread_id, existing)
    if (current.active_turn_status === "active") {
      return yield* new ThreadActor.ThreadActorActiveTurn({
        message: `Thread ${input.thread_id} already has an active turn`,
        thread_id: input.thread_id,
        ...(current.active_user_id === undefined ? {} : { active_user_id: current.active_user_id }),
      })
    }
    const sequence = existing.at(-1)?.sequence ?? 0
    const event = yield* makeContextCompacted(input, sequence + 1, idGenerator, time)
    yield* append(input.thread_id, [event])
    return event
  })

const interruptInFake = (
  input: ThreadActor.InterruptTurnPayload,
  readThread: (thread: Ids.ThreadId) => Effect.Effect<ReadonlyArray<Event.Event>>,
  append: (thread: Ids.ThreadId, events: ReadonlyArray<Event.Event>) => Effect.Effect<void>,
  workspaceAccess: WorkspaceAccess.Interface,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
) =>
  Effect.gen(function* () {
    const existing = yield* readThread(input.thread_id)
    if (existing.length === 0) {
      return yield* new ThreadActor.ThreadActorActionError({
        message: `Thread ${input.thread_id} was not found`,
        operation: "InterruptTurn",
        thread_id: input.thread_id,
      })
    }
    const summary = fakeSummaryFromEvents(input.thread_id, existing)
    if (summary !== undefined && input.identity !== undefined) {
      yield* workspaceAccess.requireThreadSummary(summary, {
        thread_id: input.thread_id,
        user_id: input.identity.user_id,
        action: "write",
      })
    }
    const terminal = terminalForTurnInFake(existing, input.turn_id)
    if (terminal !== undefined) return terminal
    const sequence = existing.at(-1)?.sequence ?? 0
    const event = yield* makeTurnFailed(input, sequence + 1, idGenerator, time)
    yield* append(input.thread_id, [event])
    return event
  })

const forkInFake = (
  input: ThreadActor.PrepareForkThreadPayload,
  readThread: (thread: Ids.ThreadId) => Effect.Effect<ReadonlyArray<Event.Event>>,
  append: (thread: Ids.ThreadId, events: ReadonlyArray<Event.Event>) => Effect.Effect<void>,
  workspaceAccess: WorkspaceAccess.Interface,
  idGenerator: IdGenerator.Interface,
) =>
  Effect.gen(function* () {
    const existing = yield* readThread(input.thread_id)
    if (existing.length === 0) {
      return yield* new ThreadActor.ThreadActorForkError({
        message: `Thread ${input.thread_id} does not exist`,
        reason: "source_missing",
        thread_id: input.thread_id,
      })
    }
    const summary = fakeSummaryFromEvents(input.thread_id, existing)
    if (summary !== undefined && input.identity !== undefined) {
      yield* workspaceAccess.requireThreadSummary(summary, {
        thread_id: input.thread_id,
        user_id: input.identity.user_id,
        action: "write",
      })
    }
    const cutoff = yield* forkCutoffInFake(existing, input.thread_id, input.at_turn)
    const created = existing.find((event): event is Event.ThreadCreated => event.type === "thread.created")
    if (created === undefined) {
      return yield* new ThreadActor.ThreadActorForkError({
        message: `Thread ${input.thread_id} does not exist`,
        reason: "source_missing",
        thread_id: input.thread_id,
      })
    }
    const forkEvents = yield* Effect.forEach(
      existing.filter((event) => event.sequence <= cutoff && event.type !== "thread.visibility.set"),
      (event, index) =>
        forkEventInFake(idGenerator, {
          event,
          sequence: index + 1,
          forkThreadId: input.fork_thread_id,
          sourceThreadId: input.thread_id,
          sourceCreated: created,
          ...(input.user_id === undefined ? {} : { userId: input.user_id }),
          ...(input.title_text === undefined ? {} : { titleText: input.title_text }),
          cutoff,
        }),
    )
    yield* append(input.fork_thread_id, forkEvents)
    return snapshot(input.fork_thread_id, yield* readThread(input.fork_thread_id))
  })

const setArchivedInFake = (
  input: ThreadActor.ThreadIdPayload,
  archived: boolean,
  readThread: (thread: Ids.ThreadId) => Effect.Effect<ReadonlyArray<Event.Event>>,
  append: (thread: Ids.ThreadId, events: ReadonlyArray<Event.Event>) => Effect.Effect<void>,
  workspaceAccess: WorkspaceAccess.Interface,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
) =>
  Effect.gen(function* () {
    const existing = yield* readThread(input.thread_id)
    if (existing.length === 0) {
      return yield* new ThreadActor.ThreadActorActionError({
        message: `Thread ${input.thread_id} was not found`,
        operation: archived ? "ArchiveThread" : "UnarchiveThread",
        thread_id: input.thread_id,
      })
    }
    const current = ThreadActor.stateFromEvents(input.thread_id, existing)
    const summary = fakeSummaryFromEvents(input.thread_id, existing)
    if (summary !== undefined && input.identity !== undefined) {
      yield* workspaceAccess.requireThreadSummary(summary, {
        thread_id: input.thread_id,
        user_id: input.identity.user_id,
        action: "write",
      })
    }
    if (current.archived === archived) return snapshot(input.thread_id, existing)
    const sequence = existing.at(-1)?.sequence ?? 0
    yield* append(input.thread_id, [yield* makeThreadArchived(input, archived, sequence + 1, idGenerator, time)])
    return snapshot(input.thread_id, yield* readThread(input.thread_id))
  })

const threadClientFakeLayer = makeThreadClientFakeLayer()

const edgeLayer = NativeEdge.layer({ token: "secret" }).pipe(
  Layer.provideMerge(threadClientFakeLayer),
  Layer.provideMerge(testLayer),
)

const edgeLayerWithoutToken = NativeEdge.layer().pipe(
  Layer.provideMerge(threadClientFakeLayer),
  Layer.provideMerge(testLayer),
)

const edgeLayerForToken = (token: string, threads: ThreadEventMap) =>
  NativeEdge.layer({ token }).pipe(
    Layer.provideMerge(makeThreadClientFakeLayer(threads)),
    Layer.provideMerge(testLayer),
  )

const authorizedHeaders = { authorization: "Bearer secret" }

const orbChangesLayer = OrbChanges.testLayer({
  changes: Effect.fn("NativeEdgeTest.orbChanges")(function* (input: OrbChanges.ChangesInput) {
    return {
      base_commit: input.base_commit,
      head_commit: "head456",
      diff: `workspace:${input.workspace_root}\n`,
      dirty: true,
    }
  }),
})

const orbFilesLayer = OrbFiles.testLayer({
  list: Effect.fn("NativeEdgeTest.orbFiles.list")(function* (input: OrbFiles.ListInput) {
    return {
      path: input.path,
      entries: [{ name: "index.ts", path: `${input.path}/index.ts`, kind: "file" as const, size: 23 }],
    }
  }),
  read: Effect.fn("NativeEdgeTest.orbFiles.read")(function* (input: OrbFiles.ReadInput) {
    if (input.path === "../secret.txt") {
      return yield* new OrbFiles.OrbFilesError({
        kind: "invalid_path",
        message: "path escapes workspace",
        operation: "read",
        workspace_root: input.workspace_root,
        path: input.path,
      })
    }
    if (input.path === "missing.txt") {
      return yield* new OrbFiles.OrbFilesError({
        kind: "not_found",
        message: "missing",
        operation: "read",
        workspace_root: input.workspace_root,
        path: input.path,
      })
    }
    return { path: input.path, kind: "text" as const, content: "hello\n", truncated: false }
  }),
})

const orbEdgeLayer = NativeEdge.layer({
  token: "secret",
  orb: true,
  workspace_root: "/workspace/orb",
  base_commit: "base123",
}).pipe(
  Layer.provideMerge(threadClientFakeLayer),
  Layer.provideMerge(orbChangesLayer),
  Layer.provideMerge(orbFilesLayer),
  Layer.provideMerge(testLayer),
)

const turnId = Ids.TurnId.make("native_edge_turn")

const makeThreadCreated = (
  input: ThreadActor.EnsureThreadPayload,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
): Effect.Effect<Event.ThreadCreated> =>
  Effect.gen(function* () {
    const createdAt = yield* time.nowMillis
    return {
      id: Ids.EventId.make(yield* idGenerator.next("event")),
      thread_id: input.thread_id,
      sequence: 1,
      version: 1,
      created_at: createdAt,
      type: "thread.created",
      data:
        input.identity === undefined
          ? { workspace_id: input.workspace_id }
          : { workspace_id: input.workspace_id, user_id: input.identity.user_id },
    }
  })

const threadCreatedForUser = (
  targetThreadId: Ids.ThreadId,
  targetWorkspaceId: Ids.WorkspaceId,
  userId: Ids.UserId,
  createdAt: Common.TimestampMillis,
): Event.ThreadCreated => ({
  id: Ids.EventId.make(`native_edge_${targetThreadId}_created`),
  thread_id: targetThreadId,
  sequence: 1,
  version: 1,
  created_at: createdAt,
  type: "thread.created",
  data: { workspace_id: targetWorkspaceId, user_id: userId },
})

const messageAddedFor = (
  targetThreadId: Ids.ThreadId,
  sequence: number,
  createdAt: Common.TimestampMillis,
  content: string,
): Event.MessageAdded => ({
  id: Ids.EventId.make(`native_edge_${targetThreadId}_message_${sequence}`),
  thread_id: targetThreadId,
  sequence,
  version: 1,
  created_at: createdAt,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make(`native_edge_${targetThreadId}_message_${sequence}`),
      thread_id: targetThreadId,
      content,
      created_at: createdAt,
    }),
  },
})

const threadVisibilitySetFor = (
  targetThreadId: Ids.ThreadId,
  sequence: number,
  createdAt: Common.TimestampMillis,
  visibility: Event.ThreadVisibility,
): Event.ThreadVisibilitySet => ({
  id: Ids.EventId.make(`native_edge_${targetThreadId}_visibility_${sequence}`),
  thread_id: targetThreadId,
  sequence,
  version: 1,
  created_at: createdAt,
  type: "thread.visibility.set",
  data: { visibility },
})

const turnStartedFor = (
  targetThreadId: Ids.ThreadId,
  sequence: number,
  createdAt: Common.TimestampMillis,
  userId: Ids.UserId,
): Event.TurnStarted => ({
  id: Ids.EventId.make(`native_edge_${targetThreadId}_turn_${sequence}`),
  thread_id: targetThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: createdAt,
  type: "turn.started",
  data: { user_id: userId },
})

const turnCompletedFor = (
  targetThreadId: Ids.ThreadId,
  sequence: number,
  createdAt: Common.TimestampMillis,
  inputTokens: number,
): Event.TurnCompleted => ({
  id: Ids.EventId.make(`native_edge_${targetThreadId}_turn_completed_${sequence}`),
  thread_id: targetThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: createdAt,
  type: "turn.completed",
  data: { provider: "fake", model: "native-edge-test", usage: { input_tokens: inputTokens } },
})

const turnFailedFor = (
  targetThreadId: Ids.ThreadId,
  sequence: number,
  createdAt: Common.TimestampMillis,
): Event.TurnFailed => ({
  id: Ids.EventId.make(`native_edge_${targetThreadId}_turn_failed_${sequence}`),
  thread_id: targetThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: createdAt,
  type: "turn.failed",
  data: { error: { kind: "cancelled", message: "cancelled" } },
})

const threadArchivedFor = (
  targetThreadId: Ids.ThreadId,
  sequence: number,
  createdAt: Common.TimestampMillis,
): Event.ThreadArchived => ({
  id: Ids.EventId.make(`native_edge_${targetThreadId}_archived_${sequence}`),
  thread_id: targetThreadId,
  sequence,
  version: 1,
  created_at: createdAt,
  type: "thread.archived",
  data: {},
})

const toolRequestedFor = (
  targetThreadId: Ids.ThreadId,
  sequence: number,
  createdAt: Common.TimestampMillis,
  path: string,
): Event.ToolCallRequested => ({
  id: Ids.EventId.make(`native_edge_${targetThreadId}_tool_${sequence}`),
  thread_id: targetThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: createdAt,
  type: "tool.call.requested",
  data: {
    call: {
      id: Ids.ToolCallId.make(`native_edge_${targetThreadId}_tool_${sequence}`),
      name: "edit",
      input: { path },
    },
  },
})

const toolCompletedFor = (
  targetThreadId: Ids.ThreadId,
  sequence: number,
  createdAt: Common.TimestampMillis,
  path: string,
): Event.ToolCallCompleted => ({
  id: Ids.EventId.make(`native_edge_${targetThreadId}_tool_completed_${sequence}`),
  thread_id: targetThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: createdAt,
  type: "tool.call.completed",
  data: {
    result: {
      id: Ids.ToolCallId.make(`native_edge_${targetThreadId}_tool_${sequence}`),
      name: "edit",
      status: "success",
      output: pierreDiff(path),
    },
  },
})

const pierreDiff = (path: string): Common.JsonValue => ({
  kind: "diff",
  renderer: "@pierre/diffs",
  collapsed: true,
  file_diff: {
    name: path,
    hunks: [
      {
        hunkContent: [
          {
            type: "change",
            additions: 3,
            deletions: 1,
          },
        ],
      },
    ],
  },
})

const membership = (
  userId: Ids.UserId,
  role: Workspace.MembershipRole,
  targetWorkspaceId: Ids.WorkspaceId,
): Workspace.Membership => ({
  workspace_id: targetWorkspaceId,
  user_id: userId,
  role,
  created_at: Common.TimestampMillis.make(1_900_000_000_000),
})

const makeTurnEvents = (
  input: ThreadActor.StartTurnPayload,
  afterSequence: number,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
): Effect.Effect<ReadonlyArray<Event.Event>> =>
  Effect.gen(function* () {
    const startedAt = yield* time.nowMillis
    const completedAt = Common.TimestampMillis.make(startedAt + 1)
    return [
      {
        id: Ids.EventId.make(yield* idGenerator.next("event")),
        thread_id: input.thread_id,
        turn_id: turnId,
        sequence: afterSequence + 1,
        version: 1,
        created_at: startedAt,
        type: "turn.started",
        data: input.identity === undefined ? {} : { user_id: input.identity.user_id },
      },
      userMessage(input, afterSequence + 2, startedAt, yield* idGenerator.next("event")),
      assistantMessage(input, afterSequence + 3, completedAt, yield* idGenerator.next("event")),
      {
        id: Ids.EventId.make(yield* idGenerator.next("event")),
        thread_id: input.thread_id,
        turn_id: turnId,
        sequence: afterSequence + 4,
        version: 1,
        created_at: completedAt,
        type: "turn.completed",
        data: { provider: "fake", model: "native-edge-test" },
      },
    ]
  })

const makeThreadVisibilitySet = (
  input: ThreadActor.SetVisibilityPayload,
  sequence: number,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
): Effect.Effect<Event.ThreadVisibilitySet> =>
  Effect.gen(function* () {
    const createdAt = yield* time.nowMillis
    return {
      id: Ids.EventId.make(yield* idGenerator.next("event")),
      thread_id: input.thread_id,
      sequence,
      version: 1,
      created_at: createdAt,
      type: "thread.visibility.set",
      data: { visibility: input.visibility },
    }
  })

const makeThreadArchived = (
  input: ThreadActor.ThreadIdPayload,
  archived: boolean,
  sequence: number,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
): Effect.Effect<Event.ThreadArchived | Event.ThreadUnarchived> =>
  Effect.gen(function* () {
    const createdAt = yield* time.nowMillis
    const common = {
      id: Ids.EventId.make(yield* idGenerator.next("event")),
      thread_id: input.thread_id,
      sequence,
      version: 1 as const,
      created_at: createdAt,
      data: {},
    }
    return archived ? { ...common, type: "thread.archived" } : { ...common, type: "thread.unarchived" }
  })

const makeContextCompacted = (
  input: ThreadActor.ThreadIdPayload,
  sequence: number,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
): Effect.Effect<Event.ContextCompacted> =>
  Effect.gen(function* () {
    return {
      id: Ids.EventId.make(yield* idGenerator.next("event")),
      thread_id: input.thread_id,
      sequence,
      version: 1,
      created_at: yield* time.nowMillis,
      type: "context.compacted",
      data: {
        summary: "native edge compacted summary",
        tail_start_sequence: Math.max(1, sequence - 2),
        trigger: "manual",
        tokens_before: 42,
        model: "native-edge-test",
      },
    }
  })

const makeTurnFailed = (
  input: ThreadActor.InterruptTurnPayload,
  sequence: number,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
): Effect.Effect<Event.TurnFailed> =>
  Effect.gen(function* () {
    return {
      id: Ids.EventId.make(yield* idGenerator.next("event")),
      thread_id: input.thread_id,
      turn_id: input.turn_id,
      sequence,
      version: 1,
      created_at: yield* time.nowMillis,
      type: "turn.failed",
      data: { error: { kind: "cancelled", message: input.reason ?? "Turn cancelled" } },
    }
  })

interface FakeForkEventInput {
  readonly event: Event.Event
  readonly sequence: number
  readonly forkThreadId: Ids.ThreadId
  readonly sourceThreadId: Ids.ThreadId
  readonly sourceCreated: Event.ThreadCreated
  readonly userId?: Ids.UserId
  readonly titleText?: string
  readonly cutoff: number
}

const forkEventInFake = (idGenerator: IdGenerator.Interface, input: FakeForkEventInput): Effect.Effect<Event.Event> =>
  Effect.gen(function* () {
    const fields = {
      id: Ids.EventId.make(yield* idGenerator.next("event")),
      thread_id: input.forkThreadId,
      sequence: input.sequence,
    }
    if (input.event.type === "thread.created") {
      return {
        ...input.event,
        ...fields,
        data: {
          workspace_id: input.sourceCreated.data.workspace_id,
          ...(input.userId === undefined ? {} : { user_id: input.userId }),
          ...(input.titleText === undefined ? {} : { title_text: input.titleText }),
          forked_from: { thread_id: input.sourceThreadId, sequence: input.cutoff },
        },
      } satisfies Event.ThreadCreated
    }
    if (input.event.type === "message.added") {
      return {
        ...input.event,
        ...fields,
        data: {
          message: {
            ...input.event.data.message,
            thread_id: input.forkThreadId,
          },
        },
      } satisfies Event.MessageAdded
    }
    return { ...input.event, ...fields } as Event.Event
  })

const forkCutoffInFake = (
  events: ReadonlyArray<Event.Event>,
  sourceThreadId: Ids.ThreadId,
  atTurn: Ids.TurnId | undefined,
): Effect.Effect<number, ThreadActor.ThreadActorForkError> => {
  if (atTurn !== undefined) {
    const terminal = events.find((event) => isTerminalTurnEvent(event) && event.turn_id === atTurn)
    if (terminal !== undefined) return Effect.succeed(terminal.sequence)
    const hasTurn = events.some((event) => event.turn_id === atTurn)
    return forkErrorInFake(sourceThreadId, hasTurn ? "turn_open" : "turn_missing", atTurn)
  }
  const lastStarted = events.findLast((event): event is Event.TurnStarted => event.type === "turn.started")
  if (
    lastStarted !== undefined &&
    !events.some((event) => isTerminalTurnEvent(event) && event.turn_id === lastStarted.turn_id)
  ) {
    return forkErrorInFake(sourceThreadId, "turn_open", lastStarted.turn_id)
  }
  return Effect.succeed(events.at(-1)?.sequence ?? 0)
}

const forkErrorInFake = (
  sourceThreadId: Ids.ThreadId,
  reason: ThreadActor.ThreadActorForkErrorReason,
  sourceTurnId?: Ids.TurnId,
) =>
  Effect.fail(
    new ThreadActor.ThreadActorForkError({
      message:
        reason === "source_missing"
          ? `Thread ${sourceThreadId} does not exist`
          : reason === "turn_missing"
            ? `Thread ${sourceThreadId} has no turn ${sourceTurnId}`
            : `Thread ${sourceThreadId} turn ${sourceTurnId} is still open`,
      reason,
      thread_id: sourceThreadId,
      ...(sourceTurnId === undefined ? {} : { turn_id: sourceTurnId }),
    }),
  )

const isTerminalTurnEvent = (event: Event.Event): event is Event.TurnCompleted | Event.TurnFailed =>
  event.type === "turn.completed" || event.type === "turn.failed"

const terminalForTurnInFake = (
  events: ReadonlyArray<Event.Event>,
  targetTurnId: Ids.TurnId,
): Event.TurnCompleted | Event.TurnFailed | undefined =>
  events.findLast(
    (event): event is Event.TurnCompleted | Event.TurnFailed =>
      isTerminalTurnEvent(event) && event.turn_id === targetTurnId,
  )

const userMessage = (
  input: ThreadActor.StartTurnPayload,
  sequence: number,
  createdAt: Common.TimestampMillis,
  eventId: string,
): Event.MessageAdded => ({
  id: Ids.EventId.make(eventId),
  thread_id: input.thread_id,
  sequence,
  version: 1,
  created_at: createdAt,
  turn_id: turnId,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make(`native_edge_user_message_${sequence}`),
      thread_id: input.thread_id,
      turn_id: turnId,
      content: input.content,
      created_at: createdAt,
    }),
  },
})

const assistantMessage = (
  input: ThreadActor.StartTurnPayload,
  sequence: number,
  createdAt: Common.TimestampMillis,
  eventId: string,
): Event.MessageAdded => ({
  id: Ids.EventId.make(eventId),
  thread_id: input.thread_id,
  sequence,
  version: 1,
  created_at: createdAt,
  turn_id: turnId,
  type: "message.added",
  data: {
    message: Message.assistant({
      id: Ids.MessageId.make(`native_edge_assistant_message_${sequence}`),
      thread_id: input.thread_id,
      turn_id: turnId,
      content: [{ type: "text", text: "native edge response" }],
      created_at: createdAt,
    }),
  },
})

const snapshot = (thread: Ids.ThreadId, events: ReadonlyArray<Event.Event>) =>
  ThreadActor.snapshotFromState(ThreadActor.stateFromEvents(thread, events), thread)

const fakeSummaryFromEvents = (
  thread: Ids.ThreadId,
  events: ReadonlyArray<Event.Event>,
): ThreadProjection.ThreadSummary | undefined => {
  const created = events.find((event): event is Event.ThreadCreated => event.type === "thread.created")
  if (created === undefined) return undefined
  const state = ThreadActor.stateFromEvents(thread, events)
  const latest = events.at(-1) ?? created
  const activeTurn =
    state.active_turn_status === "idle"
      ? {}
      : { active_turn_id: state.active_turn_id, active_turn_status: state.active_turn_status }
  return {
    thread_id: thread,
    workspace_id: created.data.workspace_id,
    ...(created.data.user_id === undefined ? {} : { user_id: created.data.user_id }),
    ...(state.latest_message_id === undefined ? {} : { latest_message_id: state.latest_message_id }),
    ...(state.latest_message_role === undefined ? {} : { latest_message_role: state.latest_message_role }),
    ...(state.latest_message_text === undefined ? {} : { latest_message_text: state.latest_message_text }),
    diff: { additions: 0, modifications: 0, deletions: 0 },
    ...activeTurn,
    archived: state.archived,
    visibility: state.visibility,
    created_at: created.created_at,
    updated_at: latest.created_at,
  }
}

const existingThreadWorkspace = (events: ReadonlyArray<Event.Event>) =>
  events.find((event): event is Event.ThreadCreated => event.type === "thread.created")?.data.workspace_id

const identityInput = (identity: ThreadActor.VerifiedUserIdentity | undefined) =>
  identity === undefined ? {} : { identity }
