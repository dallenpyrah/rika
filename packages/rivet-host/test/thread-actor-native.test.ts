import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { createServer } from "node:net"
import { AgentLoop, CompactionService, WorkspaceAccess } from "@rika/agent"
import { IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Codec, Common, Event, Ids, Message, Workspace } from "@rika/schema"
import { Client as EffectClient, Registry as EffectRegistry } from "@rivetkit/effect"
import { Context, Effect, Exit, Layer, Option, Stream } from "effect"
import { setup } from "rivetkit"
import { createClient } from "rivetkit/client"
import { ThreadActor, ThreadClient, ThreadDirectory, ThreadLive } from "../src/index"

const runId = `${process.pid}_${Date.now()}`
const threadId = Ids.ThreadId.make(`native_actor_thread_${runId}`)
const liveThreadId = Ids.ThreadId.make(`native_actor_live_${runId}`)
const workspaceId = Ids.WorkspaceId.make("native_actor_workspace")
const otherWorkspaceId = Ids.WorkspaceId.make("native_actor_other_workspace")
const turnId = Ids.TurnId.make("native_actor_turn")
const deniedUserId = Ids.UserId.make("native_actor_denied_user")
const activeUserId = Ids.UserId.make("native_actor_active_user")
const describeNative = process.env.RIKA_RUN_NATIVE_RIVET_TESTS === "1" ? describe : describe.skip
const agentLoopCalls: Array<AgentLoop.RunTurnInput> = []
const heldTurns = new Map<Ids.ThreadId, Promise<void>>()

describeNative("ThreadActor native AgentLoop storage", () => {
  let endpoint = ""

  beforeAll(async () => {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      spawnSync("pkill", ["-f", "rivet-engine"])
      delete process.env.RIVET_ENDPOINT
      delete process.env.RIVET_ENGINE
      const storagePath = mkdtempSync(join(tmpdir(), "rika-rivet-native-"))
      process.env.RIVETKIT_STORAGE_PATH = storagePath
      process.env.RIVET__FILE_SYSTEM__PATH = storagePath
      const port = await freePort()
      const context = await Effect.runPromise(Effect.scoped(Layer.build(registryLayer())))
      const registry = Context.get(context, EffectRegistry.Registry)
      const rawRegistry = setup({
        use: Object.fromEntries(registry.rivetkitActors),
        startEngine: true,
        engineHost: "127.0.0.1",
        enginePort: port,
        noWelcome: true,
        test: { enabled: true },
      })
      rawRegistry.start()
      const resolvedEndpoint = rawRegistry.parseConfig().endpoint
      if (resolvedEndpoint === undefined) throw new Error("Rivet engine endpoint was not resolved")
      try {
        await waitForEngine(resolvedEndpoint)
        await waitForThreadActor(resolvedEndpoint)
        endpoint = resolvedEndpoint
        return
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }, 180_000)

  afterAll(() => {
    spawnSync("pkill", ["-f", "rivet-engine"])
  })

  test("stores AgentLoop events in actor c.db", async () => {
    agentLoopCalls.length = 0
    await Effect.runPromise(
      ThreadClient.getEvents({ thread_id: threadId, after_sequence: 0 }).pipe(Effect.provide(clientLayer(endpoint))),
    )

    await Effect.runPromise(
      ThreadClient.startTurn({
        thread_id: threadId,
        workspace_id: workspaceId,
        content: "Reply with READY",
        mode: "rush",
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    const replayed = await waitForReplay(endpoint, threadId, 6)

    expect(agentLoopCalls[0]).toMatchObject({
      thread_id: threadId,
      workspace_id: workspaceId,
      content: "Reply with READY",
      mode: "rush",
    })
    expect(agentLoopCalls[0]?.existing_events?.map((event) => event.type)).toEqual(["thread.created"])
    expect(replayed.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(replayed.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6])
    expect(
      replayed.some(
        (event) =>
          event.type === "message.added" && Message.displayText(event.data.message) === "agent loop actor response",
      ),
    ).toBe(true)
  }, 90_000)

  test("broadcasts AgentLoop events to a raw connected subscriber", async () => {
    agentLoopCalls.length = 0

    const { liveEvents, replayed } = await collectLiveTail(endpoint, liveThreadId)

    expect(agentLoopCalls[0]).toMatchObject({
      thread_id: liveThreadId,
      workspace_id: workspaceId,
      content: "Reply with READY",
      mode: "rush",
    })
    expect(agentLoopCalls[0]?.existing_events?.map((event) => event.type)).toEqual(["thread.created"])
    expect(liveEvents.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(liveEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6])
    expect(replayed.map((event) => event.id)).toEqual(liveEvents.map((event) => event.id))
  }, 90_000)

  test("delivers the same ordered event ids to two concurrent raw live subscribers and GetEvents", async () => {
    const dualThreadId = Ids.ThreadId.make(`native_actor_dual_live_${runId}`)
    agentLoopCalls.length = 0

    const leftClient = createClient({ endpoint })
    const rightClient = createClient({ endpoint })
    const leftConn = threadEventConnection(leftClient.getOrCreate("ThreadActor", dualThreadId).connect())
    const rightConn = threadEventConnection(rightClient.getOrCreate("ThreadActor", dualThreadId).connect())
    const leftEvents: Array<Event.Event> = []
    const rightEvents: Array<Event.Event> = []
    try {
      const leftExpected = waitForLiveEvents(leftEvents, 6)
      const rightExpected = waitForLiveEvents(rightEvents, 6)
      const leftUnsub = leftConn.on("threadEvent", (encodedEvent) => {
        leftEvents.push(Codec.decode(Event.Event)(encodedEvent))
      })
      const rightUnsub = rightConn.on("threadEvent", (encodedEvent) => {
        rightEvents.push(Codec.decode(Event.Event)(encodedEvent))
      })
      try {
        await leftConn.ready
        await rightConn.ready
        await leftConn.action("GetEvents", [{ thread_id: dualThreadId, after_sequence: 0 }])
        await rightConn.action("GetEvents", [{ thread_id: dualThreadId, after_sequence: 0 }])
        await Effect.runPromise(
          ThreadClient.startTurn({
            thread_id: dualThreadId,
            workspace_id: workspaceId,
            content: "Reply with READY",
            mode: "rush",
          }).pipe(Effect.provide(clientLayer(endpoint))),
        )
        await leftExpected
        await rightExpected
        const replayed = await waitForReplay(endpoint, dualThreadId, 6)

        expect(leftEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6])
        expect(rightEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6])
        expect(leftEvents.map((event) => event.id)).toEqual(rightEvents.map((event) => event.id))
        expect(replayed.map((event) => event.id)).toEqual(leftEvents.map((event) => event.id))
        expect(replayed.map((event) => event.id)).toEqual(rightEvents.map((event) => event.id))
      } finally {
        leftUnsub()
        rightUnsub()
      }
    } finally {
      await leftConn.dispose()
      await rightConn.dispose()
      await leftClient.dispose()
      await rightClient.dispose()
    }
  }, 90_000)

  test("appends mirrored events with preserved actor sequences and exact duplicate skips", async () => {
    const mirrorThreadId = Ids.ThreadId.make(`native_actor_mirrored_${runId}`)
    const inputEvents = [
      agentThreadCreated(1, mirrorThreadId),
      agentMessageAdded(2, mirrorThreadId, "assistant", "mirrored native-mirror-secret"),
    ]

    const first = await Effect.runPromise(
      ThreadClient.appendMirroredEvents({ thread_id: mirrorThreadId, events: inputEvents }).pipe(
        Effect.provide(clientLayer(endpoint)),
      ),
    )
    const second = await Effect.runPromise(
      ThreadClient.appendMirroredEvents({ thread_id: mirrorThreadId, events: inputEvents }).pipe(
        Effect.provide(clientLayer(endpoint)),
      ),
    )
    const replayed = await Effect.runPromise(
      ThreadClient.getEvents({ thread_id: mirrorThreadId, after_sequence: 0 }).pipe(
        Effect.provide(clientLayer(endpoint)),
      ),
    )

    expect(first.inserted_events.map((event) => event.sequence)).toEqual([1, 2])
    expect(second).toEqual({ inserted_events: [], skipped_count: 2 })
    expect(replayed.map((event) => event.sequence)).toEqual([1, 2])
    expect(JSON.stringify(replayed)).toContain("[REDACTED:MIRROR_SECRET]")
    expect(JSON.stringify(replayed)).not.toContain("native-mirror-secret")
  }, 90_000)

  test("rejects gapped mirrored batches without partial actor commits", async () => {
    const mirrorThreadId = Ids.ThreadId.make(`native_actor_mirrored_gap_${runId}`)
    const exit = await Effect.runPromise(
      ThreadClient.appendMirroredEvents({
        thread_id: mirrorThreadId,
        events: [agentThreadCreated(1, mirrorThreadId), agentMessageAdded(3, mirrorThreadId, "assistant", "gap")],
      }).pipe(Effect.exit, Effect.provide(clientLayer(endpoint))),
    )
    const replayed = await Effect.runPromise(
      ThreadClient.getEvents({ thread_id: mirrorThreadId, after_sequence: 0 }).pipe(
        Effect.provide(clientLayer(endpoint)),
      ),
    )

    expect(errorFromExit(exit)).toMatchObject({
      _tag: "ThreadActorActionError",
      operation: "AppendMirroredEvents",
      thread_id: mirrorThreadId,
    })
    expect(replayed).toEqual([])
  }, 90_000)

  test("mirrored terminal events clear a hot active reservation before turn start", async () => {
    const activeThreadId = Ids.ThreadId.make(`native_actor_mirrored_terminal_${runId}`)
    const mirroredTurnId = Ids.TurnId.make(`native_actor_mirrored_terminal_turn_${runId}`)
    const releaseHeldTurn = holdTurn(activeThreadId)
    let released = false
    const release = () => {
      if (!released) {
        released = true
        releaseHeldTurn()
      }
    }

    try {
      await Effect.runPromise(
        ThreadClient.startTurn({
          thread_id: activeThreadId,
          workspace_id: workspaceId,
          identity: verifiedIdentity(activeUserId),
          content: "hold before turn started",
          mode: "rush",
        }).pipe(Effect.provide(clientLayer(endpoint))),
      )
      const active = await waitForActiveSnapshot(endpoint, activeThreadId, activeUserId)

      expect(active).toMatchObject({
        thread_id: activeThreadId,
        active_turn_status: "active",
      })
      expect(active.active_turn_id).toBeUndefined()

      await Effect.runPromise(
        ThreadClient.appendMirroredEvents({
          thread_id: activeThreadId,
          events: [
            {
              ...customTurnStarted(2, activeThreadId, mirroredTurnId),
              id: Ids.EventId.make(`native_actor_mirrored_terminal_started_${runId}`),
            },
            {
              ...customTurnCompleted(3, activeThreadId, mirroredTurnId),
              id: Ids.EventId.make(`native_actor_mirrored_terminal_completed_${runId}`),
            },
          ],
        }).pipe(Effect.provide(clientLayer(endpoint))),
      )
      const snapshot = await Effect.runPromise(
        ThreadClient.getSnapshot({ thread_id: activeThreadId }).pipe(Effect.provide(clientLayer(endpoint))),
      )

      expect(snapshot).toMatchObject({
        thread_id: activeThreadId,
        active_turn_id: mirroredTurnId,
        active_turn_status: "completed",
      })

      release()
      await Effect.runPromise(Effect.sleep("50 millis"))
      const replayed = await Effect.runPromise(
        ThreadClient.getEvents({ thread_id: activeThreadId, after_sequence: 0 }).pipe(
          Effect.provide(clientLayer(endpoint)),
        ),
      )

      expect(replayed.map((event) => event.sequence)).toEqual([1, 2, 3])
      expect(replayed.map((event) => event.turn_id).filter((id) => id !== undefined)).toEqual([
        mirroredTurnId,
        mirroredTurnId,
      ])
    } finally {
      release()
    }
  }, 90_000)

  test("persists thread directory entries in actor-local SQLite", async () => {
    const directoryThreadId = Ids.ThreadId.make(`native_actor_directory_${runId}`)
    const directoryPath = "packages/rivet-host/src/thread-directory.ts"
    const directoryEvents = [
      ...agentEventsFor(directoryThreadId),
      agentToolCompleted(7, directoryThreadId, directoryPath),
    ]

    await Effect.runPromise(ThreadDirectory.apply(directoryEvents).pipe(Effect.provide(directoryClientLayer(endpoint))))

    const listed = await Effect.runPromise(
      ThreadDirectory.listThreads().pipe(Effect.provide(directoryClientLayer(endpoint))),
    )
    const files = await Effect.runPromise(
      ThreadDirectory.listThreadFiles({ thread_id: directoryThreadId }).pipe(
        Effect.provide(directoryClientLayer(endpoint)),
      ),
    )

    expect(listed.map((summary) => summary.thread_id)).toContain(directoryThreadId)
    expect(listed.find((summary) => summary.thread_id === directoryThreadId)).toMatchObject({
      workspace_id: workspaceId,
      latest_message_text: "agent loop actor response",
      active_turn_status: "completed",
      diff: { additions: 3, modifications: 1, deletions: 1 },
    })
    expect(files).toEqual([
      {
        thread_id: directoryThreadId,
        path: directoryPath,
        first_seen_at: 7,
        last_seen_at: 7,
      },
    ])
  }, 90_000)

  test("serializes concurrent thread directory updates", async () => {
    const leftThreadId = Ids.ThreadId.make(`native_actor_directory_concurrent_left_${runId}`)
    const rightThreadId = Ids.ThreadId.make(`native_actor_directory_concurrent_right_${runId}`)

    await Promise.all([
      Effect.runPromise(
        ThreadDirectory.apply(agentEventsFor(leftThreadId)).pipe(Effect.provide(directoryClientLayer(endpoint))),
      ),
      Effect.runPromise(
        ThreadDirectory.apply(agentEventsFor(rightThreadId)).pipe(Effect.provide(directoryClientLayer(endpoint))),
      ),
    ])

    const listed = await Effect.runPromise(
      ThreadDirectory.listThreads().pipe(Effect.provide(directoryClientLayer(endpoint))),
    )
    const threadIds = listed.map((summary) => summary.thread_id)

    expect(threadIds).toContain(leftThreadId)
    expect(threadIds).toContain(rightThreadId)
  }, 90_000)

  test("denies actor c.db events to a rejected verified identity", async () => {
    const authThreadId = Ids.ThreadId.make(`native_actor_auth_${runId}`)
    agentLoopCalls.length = 0

    await Effect.runPromise(
      ThreadClient.startTurn({
        thread_id: authThreadId,
        workspace_id: workspaceId,
        content: "Reply with READY",
        mode: "rush",
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    await waitForReplay(endpoint, authThreadId, 6)

    const exit = await Effect.runPromise(
      ThreadClient.getEvents({
        thread_id: authThreadId,
        identity: verifiedIdentity(deniedUserId),
        after_sequence: 0,
      }).pipe(Effect.exit, Effect.provide(clientLayer(endpoint))),
    )

    expect(errorFromExit(exit)).toMatchObject({
      _tag: "WorkspaceAccessDenied",
      action: "read",
      workspace_id: workspaceId,
      user_id: deniedUserId,
    })
  }, 90_000)

  test("returns the hot active turn from EnsureThread while StartTurn streams", async () => {
    const activeThreadId = Ids.ThreadId.make(`native_actor_active_${runId}`)
    const releaseHeldTurn = holdTurn(activeThreadId)
    let released = false
    const release = () => {
      if (!released) {
        released = true
        releaseHeldTurn()
      }
    }
    agentLoopCalls.length = 0

    try {
      await Effect.runPromise(
        ThreadClient.startTurn({
          thread_id: activeThreadId,
          workspace_id: workspaceId,
          identity: verifiedIdentity(activeUserId),
          content: "hold turn open",
          mode: "rush",
        }).pipe(Effect.provide(clientLayer(endpoint))),
      )
      const snapshot = await waitForActiveSnapshot(endpoint, activeThreadId, activeUserId)

      expect(snapshot).toMatchObject({
        thread_id: activeThreadId,
        active_turn_status: "active",
        active_user_id: activeUserId,
      })

      release()
      await waitForReplay(endpoint, activeThreadId, 6)
    } finally {
      release()
    }
  }, 90_000)

  test("persists thread ownership before StartTurn returns for a new held turn", async () => {
    const activeThreadId = Ids.ThreadId.make(`native_actor_immediate_created_${runId}`)
    const releaseHeldTurn = holdTurn(activeThreadId)
    let released = false
    const release = () => {
      if (!released) {
        released = true
        releaseHeldTurn()
      }
    }
    agentLoopCalls.length = 0

    try {
      await Effect.runPromise(
        ThreadClient.startTurn({
          thread_id: activeThreadId,
          workspace_id: workspaceId,
          identity: verifiedIdentity(activeUserId),
          content: "hold turn open",
          mode: "rush",
        }).pipe(Effect.provide(clientLayer(endpoint))),
      )
      const events = await Effect.runPromise(
        ThreadClient.getEvents({
          thread_id: activeThreadId,
          identity: verifiedIdentity(activeUserId),
          after_sequence: 0,
        }).pipe(Effect.provide(clientLayer(endpoint))),
      )

      expect(events.map((event) => event.type)).toContain("thread.created")

      release()
      await waitForReplay(endpoint, activeThreadId, 6)
    } finally {
      release()
    }
  }, 90_000)

  test("denies hot EnsureThread snapshots using the actor-owned workspace", async () => {
    const activeThreadId = Ids.ThreadId.make(`native_actor_hot_auth_${runId}`)
    const releaseHeldTurn = holdTurn(activeThreadId)
    let released = false
    const release = () => {
      if (!released) {
        released = true
        releaseHeldTurn()
      }
    }
    agentLoopCalls.length = 0

    try {
      await Effect.runPromise(
        ThreadClient.startTurn({
          thread_id: activeThreadId,
          workspace_id: workspaceId,
          identity: verifiedIdentity(activeUserId),
          content: "hold turn open",
          mode: "rush",
        }).pipe(Effect.provide(clientLayer(endpoint))),
      )
      await waitForActiveSnapshot(endpoint, activeThreadId, activeUserId)

      const exit = await Effect.runPromise(
        ThreadClient.ensureThread({
          thread_id: activeThreadId,
          workspace_id: otherWorkspaceId,
          identity: verifiedIdentity(deniedUserId),
        }).pipe(Effect.exit, Effect.provide(clientLayer(endpoint))),
      )

      release()
      await waitForReplay(endpoint, activeThreadId, 6)

      expect(errorFromExit(exit)).toMatchObject({
        _tag: "WorkspaceAccessDenied",
        action: "read",
        workspace_id: workspaceId,
        user_id: deniedUserId,
      })
    } finally {
      release()
    }
  }, 90_000)

  test("denies hot ReplayThread snapshots using the actor-owned workspace", async () => {
    const activeThreadId = Ids.ThreadId.make(`native_actor_hot_replay_auth_${runId}`)
    const releaseHeldTurn = holdTurn(activeThreadId)
    let released = false
    const release = () => {
      if (!released) {
        released = true
        releaseHeldTurn()
      }
    }
    agentLoopCalls.length = 0

    try {
      await Effect.runPromise(
        ThreadClient.startTurn({
          thread_id: activeThreadId,
          workspace_id: workspaceId,
          identity: verifiedIdentity(activeUserId),
          content: "hold turn open",
          mode: "rush",
        }).pipe(Effect.provide(clientLayer(endpoint))),
      )
      await waitForActiveSnapshot(endpoint, activeThreadId, activeUserId)

      const exit = await Effect.runPromise(
        ThreadClient.replayThread({
          thread_id: activeThreadId,
          identity: verifiedIdentity(deniedUserId),
        }).pipe(Effect.exit, Effect.provide(clientLayer(endpoint))),
      )

      release()
      await waitForReplay(endpoint, activeThreadId, 6)

      expect(errorFromExit(exit)).toMatchObject({
        _tag: "WorkspaceAccessDenied",
        action: "read",
        workspace_id: workspaceId,
        user_id: deniedUserId,
      })
    } finally {
      release()
    }
  }, 90_000)

  test("denies hot StartTurn conflicts using the actor-owned workspace", async () => {
    const activeThreadId = Ids.ThreadId.make(`native_actor_hot_start_auth_${runId}`)
    const releaseHeldTurn = holdTurn(activeThreadId)
    let released = false
    const release = () => {
      if (!released) {
        released = true
        releaseHeldTurn()
      }
    }
    agentLoopCalls.length = 0

    try {
      await Effect.runPromise(
        ThreadClient.startTurn({
          thread_id: activeThreadId,
          workspace_id: workspaceId,
          identity: verifiedIdentity(activeUserId),
          content: "hold turn open",
          mode: "rush",
        }).pipe(Effect.provide(clientLayer(endpoint))),
      )
      await waitForActiveSnapshot(endpoint, activeThreadId, activeUserId)

      const exit = await Effect.runPromise(
        ThreadClient.startTurn({
          thread_id: activeThreadId,
          workspace_id: otherWorkspaceId,
          identity: verifiedIdentity(deniedUserId),
          content: "try denied conflict",
          mode: "rush",
        }).pipe(Effect.exit, Effect.provide(clientLayer(endpoint))),
      )

      release()
      await waitForReplay(endpoint, activeThreadId, 6)

      expect(errorFromExit(exit)).toMatchObject({
        _tag: "WorkspaceAccessDenied",
        action: "write",
        workspace_id: workspaceId,
        user_id: deniedUserId,
      })
    } finally {
      release()
    }
  }, 90_000)

  test("preserves actor-created ownership when AgentLoop omits thread.created", async () => {
    const malformedThreadId = Ids.ThreadId.make(`native_actor_malformed_${runId}`)
    agentLoopCalls.length = 0

    await Effect.runPromise(
      ThreadClient.startTurn({
        thread_id: malformedThreadId,
        workspace_id: workspaceId,
        identity: verifiedIdentity(activeUserId),
        content: "omit thread created",
        mode: "rush",
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    const replayed = await waitForReplay(endpoint, malformedThreadId, 6)

    const exit = await Effect.runPromise(
      ThreadClient.replayThread({
        thread_id: malformedThreadId,
        identity: verifiedIdentity(deniedUserId),
      }).pipe(Effect.exit, Effect.provide(clientLayer(endpoint))),
    )

    expect(replayed.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(errorFromExit(exit)).toMatchObject({
      _tag: "WorkspaceAccessDenied",
      action: "read",
      workspace_id: workspaceId,
      user_id: deniedUserId,
    })
  }, 90_000)

  test("persists SetVisibility in actor c.db and authorizes writes from actor ownership", async () => {
    const visibilityThreadId = Ids.ThreadId.make(`native_actor_visibility_${runId}`)
    agentLoopCalls.length = 0

    await Effect.runPromise(
      ThreadClient.startTurn({
        thread_id: visibilityThreadId,
        workspace_id: workspaceId,
        identity: verifiedIdentity(activeUserId),
        content: "Reply with READY",
        mode: "rush",
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    await waitForReplay(endpoint, visibilityThreadId, 6)

    const snapshot = await Effect.runPromise(
      ThreadClient.setVisibility({
        thread_id: visibilityThreadId,
        identity: verifiedIdentity(activeUserId),
        visibility: "unlisted",
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    const replayed = await waitForReplay(endpoint, visibilityThreadId, 7)
    const ensured = await Effect.runPromise(
      ThreadClient.ensureThread({
        thread_id: visibilityThreadId,
        workspace_id: otherWorkspaceId,
        identity: verifiedIdentity(activeUserId),
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    const denied = await Effect.runPromise(
      ThreadClient.setVisibility({
        thread_id: visibilityThreadId,
        identity: verifiedIdentity(deniedUserId),
        visibility: "private",
      }).pipe(Effect.exit, Effect.provide(clientLayer(endpoint))),
    )

    expect(snapshot.visibility).toBe("unlisted")
    expect(ensured.visibility).toBe("unlisted")
    expect(replayed.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
      "thread.visibility.set",
    ])
    expect(replayed.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(replayed.at(-1)).toMatchObject({
      thread_id: visibilityThreadId,
      type: "thread.visibility.set",
      data: { visibility: "unlisted" },
    })
    expect(errorFromExit(denied)).toMatchObject({
      _tag: "WorkspaceAccessDenied",
      action: "write",
      workspace_id: workspaceId,
      user_id: deniedUserId,
    })
  }, 90_000)

  test("broadcasts SetVisibility events to a raw connected subscriber", async () => {
    const visibilityLiveThreadId = Ids.ThreadId.make(`native_actor_visibility_live_${runId}`)
    agentLoopCalls.length = 0

    await Effect.runPromise(
      ThreadClient.startTurn({
        thread_id: visibilityLiveThreadId,
        workspace_id: workspaceId,
        identity: verifiedIdentity(activeUserId),
        content: "Reply with READY",
        mode: "rush",
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    await waitForReplay(endpoint, visibilityLiveThreadId, 6)

    const client = createClient({ endpoint })
    const conn = threadEventConnection(client.getOrCreate("ThreadActor", visibilityLiveThreadId).connect())
    const liveEvents: Array<Event.Event> = []
    try {
      const expected = waitForLiveEvents(liveEvents, 1)
      const unsubscribe = conn.on("threadEvent", (encodedEvent) => {
        liveEvents.push(Codec.decode(Event.Event)(encodedEvent))
      })
      try {
        await conn.ready
        await Effect.runPromise(
          ThreadClient.setVisibility({
            thread_id: visibilityLiveThreadId,
            identity: verifiedIdentity(activeUserId),
            visibility: "workspace",
          }).pipe(Effect.provide(clientLayer(endpoint))),
        )
        await expected
        const replayed = await waitForReplay(endpoint, visibilityLiveThreadId, 7)

        expect(liveEvents.map((event) => event.type)).toEqual(["thread.visibility.set"])
        expect(liveEvents[0]).toMatchObject({
          thread_id: visibilityLiveThreadId,
          sequence: 7,
          type: "thread.visibility.set",
          data: { visibility: "workspace" },
        })
        expect(replayed.at(-1)?.id).toBe(liveEvents[0]?.id)
      } finally {
        unsubscribe()
      }
    } finally {
      await conn.dispose()
      await client.dispose()
    }
  }, 90_000)

  test("persists archive lifecycle events in actor c.db and authorizes writes from actor ownership", async () => {
    const archiveThreadId = Ids.ThreadId.make(`native_actor_archive_${runId}`)
    agentLoopCalls.length = 0

    await Effect.runPromise(
      ThreadClient.startTurn({
        thread_id: archiveThreadId,
        workspace_id: workspaceId,
        identity: verifiedIdentity(activeUserId),
        content: "Reply with READY",
        mode: "rush",
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    await waitForReplay(endpoint, archiveThreadId, 6)

    const archived = await Effect.runPromise(
      ThreadClient.archiveThread({
        thread_id: archiveThreadId,
        identity: verifiedIdentity(activeUserId),
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    const unarchived = await Effect.runPromise(
      ThreadClient.unarchiveThread({
        thread_id: archiveThreadId,
        identity: verifiedIdentity(activeUserId),
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    const replayed = await waitForReplay(endpoint, archiveThreadId, 8)
    const denied = await Effect.runPromise(
      ThreadClient.archiveThread({
        thread_id: archiveThreadId,
        identity: verifiedIdentity(deniedUserId),
      }).pipe(Effect.exit, Effect.provide(clientLayer(endpoint))),
    )

    expect(archived.archived).toBe(true)
    expect(unarchived.archived).toBe(false)
    expect(replayed.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
      "thread.archived",
      "thread.unarchived",
    ])
    expect(replayed.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(errorFromExit(denied)).toMatchObject({
      _tag: "WorkspaceAccessDenied",
      action: "write",
      workspace_id: workspaceId,
      user_id: deniedUserId,
    })
  }, 90_000)

  test("broadcasts archive lifecycle events to a raw connected subscriber", async () => {
    const archiveLiveThreadId = Ids.ThreadId.make(`native_actor_archive_live_${runId}`)
    agentLoopCalls.length = 0

    await Effect.runPromise(
      ThreadClient.startTurn({
        thread_id: archiveLiveThreadId,
        workspace_id: workspaceId,
        identity: verifiedIdentity(activeUserId),
        content: "Reply with READY",
        mode: "rush",
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    await waitForReplay(endpoint, archiveLiveThreadId, 6)

    const client = createClient({ endpoint })
    const conn = threadEventConnection(client.getOrCreate("ThreadActor", archiveLiveThreadId).connect())
    const liveEvents: Array<Event.Event> = []
    try {
      const expected = waitForLiveEvents(liveEvents, 2)
      const unsubscribe = conn.on("threadEvent", (encodedEvent) => {
        liveEvents.push(Codec.decode(Event.Event)(encodedEvent))
      })
      try {
        await conn.ready
        await Effect.runPromise(
          ThreadClient.archiveThread({
            thread_id: archiveLiveThreadId,
            identity: verifiedIdentity(activeUserId),
          }).pipe(Effect.provide(clientLayer(endpoint))),
        )
        await Effect.runPromise(
          ThreadClient.unarchiveThread({
            thread_id: archiveLiveThreadId,
            identity: verifiedIdentity(activeUserId),
          }).pipe(Effect.provide(clientLayer(endpoint))),
        )
        await expected
        const replayed = await waitForReplay(endpoint, archiveLiveThreadId, 8)

        expect(liveEvents.map((event) => event.type)).toEqual(["thread.archived", "thread.unarchived"])
        expect(liveEvents.map((event) => event.sequence)).toEqual([7, 8])
        expect(replayed.slice(-2).map((event) => event.id)).toEqual(liveEvents.map((event) => event.id))
      } finally {
        unsubscribe()
      }
    } finally {
      await conn.dispose()
      await client.dispose()
    }
  }, 90_000)

  test("persists manual compaction events in actor c.db and authorizes writes from actor ownership", async () => {
    const compactThreadId = Ids.ThreadId.make(`native_actor_compact_${runId}`)
    agentLoopCalls.length = 0

    await Effect.runPromise(
      ThreadClient.startTurn({
        thread_id: compactThreadId,
        workspace_id: workspaceId,
        identity: verifiedIdentity(activeUserId),
        content: "Reply with READY",
        mode: "rush",
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    await waitForReplay(endpoint, compactThreadId, 6)

    const compacted = await Effect.runPromise(
      ThreadClient.compactThread({
        thread_id: compactThreadId,
        identity: verifiedIdentity(activeUserId),
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    const replayed = await waitForReplay(endpoint, compactThreadId, 7)
    const denied = await Effect.runPromise(
      ThreadClient.compactThread({
        thread_id: compactThreadId,
        identity: verifiedIdentity(deniedUserId),
      }).pipe(Effect.exit, Effect.provide(clientLayer(endpoint))),
    )

    expect(compacted).toMatchObject({
      thread_id: compactThreadId,
      sequence: 7,
      type: "context.compacted",
      data: { trigger: "manual", summary: "native actor compacted summary" },
    })
    expect(replayed.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
      "context.compacted",
    ])
    expect(errorFromExit(denied)).toMatchObject({
      _tag: "WorkspaceAccessDenied",
      action: "write",
      workspace_id: workspaceId,
      user_id: deniedUserId,
    })
  }, 90_000)

  test("returns active-turn conflict when compacting a running actor turn", async () => {
    const activeCompactThreadId = Ids.ThreadId.make(`native_actor_compact_active_${runId}`)
    const releaseHeldTurn = holdTurn(activeCompactThreadId)
    let released = false
    const release = () => {
      if (!released) {
        released = true
        releaseHeldTurn()
      }
    }
    agentLoopCalls.length = 0

    try {
      await Effect.runPromise(
        ThreadClient.startTurn({
          thread_id: activeCompactThreadId,
          workspace_id: workspaceId,
          identity: verifiedIdentity(activeUserId),
          content: "hold turn open",
          mode: "rush",
        }).pipe(Effect.provide(clientLayer(endpoint))),
      )
      await waitForActiveSnapshot(endpoint, activeCompactThreadId, activeUserId)

      const exit = await Effect.runPromise(
        ThreadClient.compactThread({
          thread_id: activeCompactThreadId,
          identity: verifiedIdentity(activeUserId),
        }).pipe(Effect.exit, Effect.provide(clientLayer(endpoint))),
      )

      release()
      await waitForReplay(endpoint, activeCompactThreadId, 6)

      expect(errorFromExit(exit)).toMatchObject({
        _tag: "ThreadActorActiveTurn",
        thread_id: activeCompactThreadId,
        active_user_id: activeUserId,
      })
    } finally {
      release()
    }
  }, 90_000)

  test("interrupts a running actor turn and persists one terminal failure", async () => {
    const interruptThreadId = Ids.ThreadId.make(`native_actor_interrupt_${runId}`)
    const releaseHeldTurn = holdTurn(interruptThreadId)
    let released = false
    const release = () => {
      if (!released) {
        released = true
        releaseHeldTurn()
      }
    }
    agentLoopCalls.length = 0

    try {
      await Effect.runPromise(
        ThreadClient.startTurn({
          thread_id: interruptThreadId,
          workspace_id: workspaceId,
          identity: verifiedIdentity(activeUserId),
          content: "hold turn open",
          mode: "rush",
        }).pipe(Effect.provide(clientLayer(endpoint))),
      )
      const snapshot = await waitForActiveSnapshot(endpoint, interruptThreadId, activeUserId)
      const interrupted = await Effect.runPromise(
        ThreadClient.interruptTurn({
          thread_id: interruptThreadId,
          turn_id: snapshot.active_turn_id ?? turnId,
          identity: verifiedIdentity(activeUserId),
          reason: "native test interrupt",
        }).pipe(Effect.provide(clientLayer(endpoint))),
      )
      const repeated = await Effect.runPromise(
        ThreadClient.interruptTurn({
          thread_id: interruptThreadId,
          turn_id: snapshot.active_turn_id ?? turnId,
          identity: verifiedIdentity(activeUserId),
          reason: "native test repeat",
        }).pipe(Effect.provide(clientLayer(endpoint))),
      )
      release()
      const replayed = await waitForReplay(endpoint, interruptThreadId, 3)

      expect(interrupted).toMatchObject({
        thread_id: interruptThreadId,
        turn_id: snapshot.active_turn_id,
        type: "turn.failed",
      })
      expect(repeated.id).toBe(interrupted.id)
      expect(replayed.map((event) => event.type)).toEqual(["thread.created", "turn.started", "turn.failed"])
    } finally {
      release()
    }
  }, 90_000)

  test("broadcasts compact events to a raw connected subscriber", async () => {
    const compactLiveThreadId = Ids.ThreadId.make(`native_actor_compact_live_${runId}`)
    agentLoopCalls.length = 0

    await Effect.runPromise(
      ThreadClient.startTurn({
        thread_id: compactLiveThreadId,
        workspace_id: workspaceId,
        identity: verifiedIdentity(activeUserId),
        content: "Reply with READY",
        mode: "rush",
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    await waitForReplay(endpoint, compactLiveThreadId, 6)

    const client = createClient({ endpoint })
    const conn = threadEventConnection(client.getOrCreate("ThreadActor", compactLiveThreadId).connect())
    const liveEvents: Array<Event.Event> = []
    try {
      const expected = waitForLiveEvents(liveEvents, 1)
      const unsubscribe = conn.on("threadEvent", (encodedEvent) => {
        liveEvents.push(Codec.decode(Event.Event)(encodedEvent))
      })
      try {
        await conn.ready
        await Effect.runPromise(
          ThreadClient.compactThread({
            thread_id: compactLiveThreadId,
            identity: verifiedIdentity(activeUserId),
          }).pipe(Effect.provide(clientLayer(endpoint))),
        )
        await expected
        const replayed = await waitForReplay(endpoint, compactLiveThreadId, 7)

        expect(liveEvents.map((event) => event.type)).toEqual(["context.compacted"])
        expect(liveEvents.map((event) => event.sequence)).toEqual([7])
        expect(replayed.at(-1)?.id).toBe(liveEvents[0]?.id)
      } finally {
        unsubscribe()
      }
    } finally {
      await conn.dispose()
      await client.dispose()
    }
  }, 90_000)

  test("persists fork imports in the fork actor c.db and authorizes source writes", async () => {
    const forkSourceThreadId = Ids.ThreadId.make(`native_actor_fork_source_${runId}`)
    const forkThreadId = Ids.ThreadId.make(`native_actor_fork_target_${runId}`)
    agentLoopCalls.length = 0

    await Effect.runPromise(
      ThreadClient.startTurn({
        thread_id: forkSourceThreadId,
        workspace_id: workspaceId,
        identity: verifiedIdentity(activeUserId),
        content: "Reply with READY",
        mode: "rush",
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    const source = await waitForReplay(endpoint, forkSourceThreadId, 6)
    const terminal = source.find((event): event is Event.TurnCompleted => event.type === "turn.completed")
    const forked = await Effect.runPromise(
      ThreadClient.forkThread({
        thread_id: forkSourceThreadId,
        fork_thread_id: forkThreadId,
        identity: verifiedIdentity(activeUserId),
        import_identity: verifiedIdentity(activeUserId),
        at_turn: terminal?.turn_id,
        user_id: activeUserId,
        title_text: "native fork title",
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    const replayed = await waitForReplay(endpoint, forkThreadId, 6)
    const denied = await Effect.runPromise(
      ThreadClient.forkThread({
        thread_id: forkSourceThreadId,
        fork_thread_id: Ids.ThreadId.make(`native_actor_fork_denied_${runId}`),
        identity: verifiedIdentity(deniedUserId),
        import_identity: verifiedIdentity(deniedUserId),
      }).pipe(Effect.exit, Effect.provide(clientLayer(endpoint))),
    )

    const created = replayed.find((event): event is Event.ThreadCreated => event.type === "thread.created")
    const message = replayed.find((event): event is Event.MessageAdded => event.type === "message.added")
    expect(forked.thread_id).toBe(forkThreadId)
    expect(replayed.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(replayed.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6])
    expect(replayed.every((event) => event.thread_id === forkThreadId)).toBe(true)
    expect(created?.data).toMatchObject({
      workspace_id: workspaceId,
      user_id: activeUserId,
      title_text: "native fork title",
      forked_from: { thread_id: forkSourceThreadId, sequence: terminal?.sequence },
    })
    expect(message?.data.message.thread_id).toBe(forkThreadId)
    expect(errorFromExit(denied)).toMatchObject({
      _tag: "WorkspaceAccessDenied",
      action: "write",
      workspace_id: workspaceId,
      user_id: deniedUserId,
    })
  }, 90_000)

  test("returns typed fork error when forking a running source turn", async () => {
    const openForkSourceThreadId = Ids.ThreadId.make(`native_actor_fork_open_source_${runId}`)
    const openForkThreadId = Ids.ThreadId.make(`native_actor_fork_open_target_${runId}`)
    const releaseHeldTurn = holdTurn(openForkSourceThreadId)
    let released = false
    const release = () => {
      if (!released) {
        released = true
        releaseHeldTurn()
      }
    }
    agentLoopCalls.length = 0

    try {
      await Effect.runPromise(
        ThreadClient.startTurn({
          thread_id: openForkSourceThreadId,
          workspace_id: workspaceId,
          identity: verifiedIdentity(activeUserId),
          content: "hold turn open",
          mode: "rush",
        }).pipe(Effect.provide(clientLayer(endpoint))),
      )
      const snapshot = await waitForActiveSnapshot(endpoint, openForkSourceThreadId, activeUserId)
      const exit = await Effect.runPromise(
        ThreadClient.forkThread({
          thread_id: openForkSourceThreadId,
          fork_thread_id: openForkThreadId,
          identity: verifiedIdentity(activeUserId),
          import_identity: verifiedIdentity(activeUserId),
        }).pipe(Effect.exit, Effect.provide(clientLayer(endpoint))),
      )

      release()
      await waitForReplay(endpoint, openForkSourceThreadId, 6)

      expect(errorFromExit(exit)).toMatchObject({
        _tag: "ThreadActorForkError",
        reason: "turn_open",
        thread_id: openForkSourceThreadId,
        turn_id: snapshot.active_turn_id,
      })
    } finally {
      release()
    }
  }, 90_000)

  test("returns typed fork error before an active turn emits a durable turn id", async () => {
    const openForkSourceThreadId = Ids.ThreadId.make(`native_actor_fork_pre_start_source_${runId}`)
    const openForkThreadId = Ids.ThreadId.make(`native_actor_fork_pre_start_target_${runId}`)
    const releaseHeldTurn = holdTurn(openForkSourceThreadId)
    let released = false
    const release = () => {
      if (!released) {
        released = true
        releaseHeldTurn()
      }
    }
    agentLoopCalls.length = 0

    try {
      await Effect.runPromise(
        ThreadClient.startTurn({
          thread_id: openForkSourceThreadId,
          workspace_id: workspaceId,
          identity: verifiedIdentity(activeUserId),
          content: "hold before turn started",
          mode: "rush",
        }).pipe(Effect.provide(clientLayer(endpoint))),
      )
      const snapshot = await waitForActiveSnapshot(endpoint, openForkSourceThreadId, activeUserId)
      const exit = await Effect.runPromise(
        ThreadClient.forkThread({
          thread_id: openForkSourceThreadId,
          fork_thread_id: openForkThreadId,
          identity: verifiedIdentity(activeUserId),
          import_identity: verifiedIdentity(activeUserId),
        }).pipe(Effect.exit, Effect.provide(clientLayer(endpoint))),
      )

      release()
      await waitForReplay(endpoint, openForkSourceThreadId, 6)

      const error = errorFromExit(exit)
      expect(snapshot.active_turn_id).toBeUndefined()
      expect(error).toMatchObject({
        _tag: "ThreadActorForkError",
        reason: "turn_open",
        thread_id: openForkSourceThreadId,
      })
      expect(Reflect.has(Object(error), "turn_id")).toBe(false)
    } finally {
      release()
    }
  }, 90_000)

  test("forks an earlier completed turn while a later source turn is active", async () => {
    const sourceThreadId = Ids.ThreadId.make(`native_actor_fork_completed_before_active_${runId}`)
    const targetThreadId = Ids.ThreadId.make(`native_actor_fork_completed_before_active_target_${runId}`)
    const originThreadId = Ids.ThreadId.make(`native_actor_fork_completed_before_active_origin_${runId}`)
    const completedTurnId = Ids.TurnId.make(`native_actor_completed_before_active_turn_${runId}`)
    const activeTurnId = Ids.TurnId.make(`native_actor_later_active_turn_${runId}`)

    await Effect.runPromise(
      Effect.gen(function* () {
        const accessor = yield* ThreadActor.ThreadActor.client
        return yield* accessor.getOrCreate(sourceThreadId).ImportForkThread({
          thread_id: sourceThreadId,
          identity: verifiedIdentity(activeUserId),
          events: activeAfterCompletedForkSourceEventsFor(
            sourceThreadId,
            originThreadId,
            completedTurnId,
            activeTurnId,
          ),
        })
      }).pipe(Effect.provide(EffectClient.layer({ endpoint }))),
    )
    const forked = await Effect.runPromise(
      ThreadClient.forkThread({
        thread_id: sourceThreadId,
        fork_thread_id: targetThreadId,
        identity: verifiedIdentity(activeUserId),
        import_identity: verifiedIdentity(activeUserId),
        at_turn: completedTurnId,
        user_id: activeUserId,
      }).pipe(Effect.provide(clientLayer(endpoint))),
    )
    const replayed = await waitForReplay(endpoint, targetThreadId, 3)

    expect(forked.thread_id).toBe(targetThreadId)
    expect(replayed.map((event) => event.type)).toEqual(["thread.created", "turn.started", "turn.completed"])
    expect(replayed.some((event) => event.turn_id === activeTurnId)).toBe(false)
    expect(replayed.find((event): event is Event.ThreadCreated => event.type === "thread.created")?.data).toMatchObject(
      {
        user_id: activeUserId,
        forked_from: { thread_id: sourceThreadId, sequence: 3 },
      },
    )
  }, 90_000)

  test("rejects malformed direct fork imports", async () => {
    const malformedForkThreadId = Ids.ThreadId.make(`native_actor_fork_malformed_${runId}`)
    const malformed = await Effect.runPromise(
      Effect.gen(function* () {
        const accessor = yield* ThreadActor.ThreadActor.client
        return yield* accessor.getOrCreate(malformedForkThreadId).ImportForkThread({
          thread_id: malformedForkThreadId,
          identity: verifiedIdentity(activeUserId),
          events: [agentMessageAdded(1, malformedForkThreadId, "user", "malformed import")],
        })
      }).pipe(Effect.exit, Effect.provide(EffectClient.layer({ endpoint }))),
    )

    expect(errorFromExit(malformed)).toMatchObject({
      _tag: "ThreadActorActionError",
      operation: "ImportForkThread",
      thread_id: malformedForkThreadId,
    })
  }, 90_000)

  test("rejects duplicate event ids before writing direct fork imports", async () => {
    const duplicateForkThreadId = Ids.ThreadId.make(`native_actor_fork_duplicate_${runId}`)
    const sourceThreadId = Ids.ThreadId.make(`native_actor_fork_duplicate_source_${runId}`)
    const duplicate = await Effect.runPromise(
      Effect.gen(function* () {
        const accessor = yield* ThreadActor.ThreadActor.client
        return yield* accessor.getOrCreate(duplicateForkThreadId).ImportForkThread({
          thread_id: duplicateForkThreadId,
          identity: verifiedIdentity(activeUserId),
          events: duplicateIdForkImportEventsFor(duplicateForkThreadId, sourceThreadId),
        })
      }).pipe(Effect.exit, Effect.provide(EffectClient.layer({ endpoint }))),
    )
    const replayed = await Effect.runPromise(
      ThreadClient.getEvents({ thread_id: duplicateForkThreadId }).pipe(Effect.provide(clientLayer(endpoint))),
    )

    expect(errorFromExit(duplicate)).toMatchObject({
      _tag: "ThreadActorActionError",
      operation: "ImportForkThread",
      thread_id: duplicateForkThreadId,
    })
    expect(replayed).toEqual([])
  }, 90_000)

  test("authorizes direct fork imports before writing target actor events", async () => {
    const unauthorizedForkThreadId = Ids.ThreadId.make(`native_actor_fork_import_denied_${runId}`)
    const sourceThreadId = Ids.ThreadId.make(`native_actor_fork_import_source_${runId}`)
    const denied = await Effect.runPromise(
      Effect.gen(function* () {
        const accessor = yield* ThreadActor.ThreadActor.client
        return yield* accessor.getOrCreate(unauthorizedForkThreadId).ImportForkThread({
          thread_id: unauthorizedForkThreadId,
          identity: verifiedIdentity(deniedUserId),
          events: forkImportEventsFor(unauthorizedForkThreadId, sourceThreadId),
        })
      }).pipe(Effect.exit, Effect.provide(EffectClient.layer({ endpoint }))),
    )
    const replayed = await Effect.runPromise(
      ThreadClient.getEvents({ thread_id: unauthorizedForkThreadId }).pipe(Effect.provide(clientLayer(endpoint))),
    )

    expect(errorFromExit(denied)).toMatchObject({
      _tag: "WorkspaceAccessDenied",
      action: "write",
      workspace_id: workspaceId,
      user_id: deniedUserId,
    })
    expect(replayed).toEqual([])
  }, 90_000)
})

const registryLayer = () =>
  Layer.mergeAll(ThreadLive.layer, ThreadDirectory.actorLayer).pipe(
    Layer.provideMerge(supportLayer),
    Layer.provideMerge(EffectRegistry.layer()),
  )

const supportLayer = Layer.mergeAll(
  IdGenerator.sequenceLayer(1),
  Time.fixedLayer(Common.TimestampMillis.make(1_910_000_000_000)),
  SecretRedactor.layerFromEntries([{ label: "MIRROR_SECRET", value: "native-mirror-secret" }]),
  CompactionService.fakeLayer({
    compact: Effect.fn("ThreadActorNative.test.compact")(function* (input: CompactionService.CompactInput) {
      return { event: nativeContextCompacted(input.thread_id), tokens_before: 42 }
    }),
  }),
  Layer.succeed(
    AgentLoop.Service,
    AgentLoop.Service.of({
      runTurn: Effect.fn("ThreadActorNative.test.runTurn")(function* (input: AgentLoop.RunTurnInput) {
        agentLoopCalls.push(input)
        const events = agentEventsFor(input.thread_id)
        return { thread_id: input.thread_id, turn_id: turnId, status: "completed" as const, events }
      }),
      streamTurn: (input) =>
        Stream.suspend(() => {
          agentLoopCalls.push(input)
          const events = agentEventsAfterExisting(input)
          if (input.content === "omit thread created")
            return Stream.fromIterable(events.filter((event) => event.type !== "thread.created"))
          if (input.content === "hold turn open") {
            const delayedIndex = events.findIndex((event) => event.type === "message.added")
            const delayedEvent = delayedIndex < 0 ? undefined : events[delayedIndex]
            if (delayedEvent === undefined) return Stream.fromIterable(events)
            const hold = heldTurns.get(input.thread_id) ?? Promise.resolve()
            return Stream.make(...events.slice(0, delayedIndex)).pipe(
              Stream.concat(Stream.fromEffect(Effect.promise(() => hold).pipe(Effect.as(delayedEvent)))),
              Stream.concat(Stream.fromIterable(events.slice(delayedIndex + 1))),
            )
          }
          if (input.content === "hold before turn started") {
            const delayedIndex = events.findIndex((event) => event.type === "turn.started")
            const delayedEvent = delayedIndex < 0 ? undefined : events[delayedIndex]
            if (delayedEvent === undefined) return Stream.fromIterable(events)
            const hold = heldTurns.get(input.thread_id) ?? Promise.resolve()
            return Stream.make(...events.slice(0, delayedIndex)).pipe(
              Stream.concat(Stream.fromEffect(Effect.promise(() => hold).pipe(Effect.as(delayedEvent)))),
              Stream.concat(Stream.fromIterable(events.slice(delayedIndex + 1))),
            )
          }
          return Stream.fromIterable(events)
        }),
      cancelTurn: Effect.fn("ThreadActorNative.test.cancelTurn")(function* (input: AgentLoop.CancelTurnInput) {
        return {
          status: "inserted" as const,
          event: turnFailed(1, input.thread_id, input.turn_id),
        }
      }),
    }),
  ),
  Layer.succeed(
    WorkspaceAccess.Service,
    WorkspaceAccess.Service.of({
      authorizeWorkspace: (input) => Effect.succeed(allowWorkspace(input)),
      requireWorkspace: (input) => requireWorkspace(input),
      authorizeThread: (input) => Effect.succeed(allowThread(input)),
      requireThread: (input) => requireThread(input),
      authorizeThreadSummary: (summary, input) => Effect.succeed(allowThreadSummary(summary.workspace_id, input)),
      requireThreadSummary: (summary, input) => requireThreadSummary(summary.workspace_id, input),
      ensureWorkspaceForCreate: (input) => requireWorkspace(input),
      filterReadableThreads: (summaries) => Effect.succeed(summaries),
      filterDiscoverableThreads: (summaries) => Effect.succeed(summaries),
    }),
  ),
)

const clientLayer = (endpoint: string) => ThreadClient.layer.pipe(Layer.provideMerge(EffectClient.layer({ endpoint })))

const directoryClientLayer = (endpoint: string) =>
  ThreadDirectory.liveLayer.pipe(Layer.provideMerge(EffectClient.layer({ endpoint })))

const holdTurn = (targetThreadId: Ids.ThreadId) => {
  let release: (() => void) | undefined
  heldTurns.set(
    targetThreadId,
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  return () => {
    heldTurns.delete(targetThreadId)
    release?.()
  }
}

const verifiedIdentity = (userId: Ids.UserId) => ({
  _tag: "VerifiedUserIdentity" as const,
  user_id: userId,
})

const errorFromExit = <A, E>(exit: Exit.Exit<A, E>) => Option.getOrUndefined(Exit.findErrorOption(exit))

const allowWorkspace = (input: WorkspaceAccess.WorkspaceAccessInput): Workspace.AccessDecision => ({
  allowed: true,
  action: input.action,
  workspace_id: input.workspace_id,
  ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
})

const allowThread = (input: WorkspaceAccess.ThreadAccessInput): Workspace.AccessDecision =>
  allowThreadSummary(workspaceId, input)

const allowThreadSummary = (
  targetWorkspaceId: Ids.WorkspaceId,
  input: WorkspaceAccess.ThreadAccessInput,
): Workspace.AccessDecision => ({
  allowed: true,
  action: input.action,
  workspace_id: targetWorkspaceId,
  ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
})

const requireWorkspace = (input: WorkspaceAccess.WorkspaceAccessInput) =>
  input.user_id === deniedUserId && input.workspace_id === workspaceId
    ? Effect.fail(accessDenied(input.action, input.workspace_id, input.user_id))
    : Effect.succeed(allowWorkspace(input))

const requireThread = (input: WorkspaceAccess.ThreadAccessInput) =>
  input.user_id === deniedUserId
    ? Effect.fail(accessDenied(input.action, workspaceId, input.user_id))
    : Effect.succeed(allowThread(input))

const requireThreadSummary = (targetWorkspaceId: Ids.WorkspaceId, input: WorkspaceAccess.ThreadAccessInput) =>
  input.user_id === deniedUserId && targetWorkspaceId === workspaceId
    ? Effect.fail(accessDenied(input.action, targetWorkspaceId, input.user_id))
    : Effect.succeed(allowThreadSummary(targetWorkspaceId, input))

const accessDenied = (action: Workspace.AccessAction, targetWorkspaceId: Ids.WorkspaceId, userId: Ids.UserId) =>
  new WorkspaceAccess.WorkspaceAccessDenied({
    message: "denied",
    action,
    workspace_id: targetWorkspaceId,
    user_id: userId,
  })

const agentEventsFor = (targetThreadId: Ids.ThreadId): ReadonlyArray<Event.Event> => [
  agentThreadCreated(1, targetThreadId),
  agentTurnStarted(2, targetThreadId),
  agentMessageAdded(3, targetThreadId, "user", "Reply with READY"),
  agentModelStreamChunk(4, targetThreadId),
  agentMessageAdded(5, targetThreadId, "assistant", "agent loop actor response"),
  agentTurnCompleted(6, targetThreadId),
]

const forkImportEventsFor = (
  targetThreadId: Ids.ThreadId,
  sourceThreadId: Ids.ThreadId,
): ReadonlyArray<Event.Event> => [forkImportCreatedFor(targetThreadId, sourceThreadId)]

const forkImportCreatedFor = (targetThreadId: Ids.ThreadId, sourceThreadId: Ids.ThreadId): Event.ThreadCreated => ({
  ...agentThreadCreated(1, targetThreadId),
  data: {
    workspace_id: workspaceId,
    user_id: activeUserId,
    forked_from: { thread_id: sourceThreadId, sequence: 1 },
  },
})

const duplicateIdForkImportEventsFor = (
  targetThreadId: Ids.ThreadId,
  sourceThreadId: Ids.ThreadId,
): ReadonlyArray<Event.Event> => {
  const created = forkImportCreatedFor(targetThreadId, sourceThreadId)
  return [
    created,
    {
      ...agentMessageAdded(2, targetThreadId, "user", "duplicate id import"),
      id: created.id,
    },
  ]
}

const activeAfterCompletedForkSourceEventsFor = (
  targetThreadId: Ids.ThreadId,
  sourceThreadId: Ids.ThreadId,
  completedTurnId: Ids.TurnId,
  activeTurnId: Ids.TurnId,
): ReadonlyArray<Event.Event> => [
  forkImportCreatedFor(targetThreadId, sourceThreadId),
  customTurnStarted(2, targetThreadId, completedTurnId),
  customTurnCompleted(3, targetThreadId, completedTurnId),
  customTurnStarted(4, targetThreadId, activeTurnId),
]

const agentEventsAfterExisting = (input: AgentLoop.RunTurnInput): ReadonlyArray<Event.Event> => {
  const latestExisting = input.existing_events?.at(-1)?.sequence ?? 0
  return agentEventsFor(input.thread_id).filter((event) => event.sequence > latestExisting)
}

const eventPrefixFor = (targetThreadId: Ids.ThreadId) => `native_agent_loop_${targetThreadId}`

const agentThreadCreated = (sequence: number, targetThreadId: Ids.ThreadId): Event.ThreadCreated => ({
  id: Ids.EventId.make(`${eventPrefixFor(targetThreadId)}_event_${sequence}`),
  thread_id: targetThreadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const agentTurnStarted = (sequence: number, targetThreadId: Ids.ThreadId): Event.TurnStarted => ({
  id: Ids.EventId.make(`${eventPrefixFor(targetThreadId)}_event_${sequence}`),
  thread_id: targetThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.started",
  data: { mode: "rush" },
})

const customTurnStarted = (
  sequence: number,
  targetThreadId: Ids.ThreadId,
  targetTurnId: Ids.TurnId,
): Event.TurnStarted => ({
  id: Ids.EventId.make(`${eventPrefixFor(targetThreadId)}_event_${sequence}`),
  thread_id: targetThreadId,
  turn_id: targetTurnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.started",
  data: { mode: "rush", user_id: activeUserId },
})

const agentMessageAdded = (
  sequence: number,
  targetThreadId: Ids.ThreadId,
  role: "user" | "assistant",
  content: string,
): Event.MessageAdded => ({
  id: Ids.EventId.make(`${eventPrefixFor(targetThreadId)}_event_${sequence}`),
  thread_id: targetThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "message.added",
  data: {
    message:
      role === "user"
        ? Message.user({
            id: Ids.MessageId.make(`${eventPrefixFor(targetThreadId)}_message_${sequence}`),
            thread_id: targetThreadId,
            turn_id: turnId,
            content,
            created_at: sequence,
          })
        : Message.assistant({
            id: Ids.MessageId.make(`${eventPrefixFor(targetThreadId)}_message_${sequence}`),
            thread_id: targetThreadId,
            turn_id: turnId,
            content: [Message.text(content)],
            created_at: sequence,
          }),
  },
})

const agentModelStreamChunk = (sequence: number, targetThreadId: Ids.ThreadId): Event.Event =>
  ({
    id: Ids.EventId.make(`${eventPrefixFor(targetThreadId)}_event_${sequence}`),
    thread_id: targetThreadId,
    turn_id: turnId,
    sequence,
    version: 1,
    created_at: sequence,
    type: "model.stream.chunk",
    data: { text: "agent loop actor response", provider: "test", model: "test" },
  }) as Event.Event

const agentTurnCompleted = (sequence: number, targetThreadId: Ids.ThreadId): Event.TurnCompleted => ({
  id: Ids.EventId.make(`${eventPrefixFor(targetThreadId)}_event_${sequence}`),
  thread_id: targetThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.completed",
  data: { provider: "test", model: "test" },
})

const agentToolCompleted = (sequence: number, targetThreadId: Ids.ThreadId, path: string): Event.ToolCallCompleted => ({
  id: Ids.EventId.make(`${eventPrefixFor(targetThreadId)}_event_${sequence}`),
  thread_id: targetThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "tool.call.completed",
  data: {
    result: {
      id: Ids.ToolCallId.make(`${eventPrefixFor(targetThreadId)}_tool_${sequence}`),
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

const customTurnCompleted = (
  sequence: number,
  targetThreadId: Ids.ThreadId,
  targetTurnId: Ids.TurnId,
): Event.TurnCompleted => ({
  id: Ids.EventId.make(`${eventPrefixFor(targetThreadId)}_event_${sequence}`),
  thread_id: targetThreadId,
  turn_id: targetTurnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.completed",
  data: { provider: "test", model: "test" },
})

const nativeContextCompacted = (targetThreadId: Ids.ThreadId): Event.ContextCompacted => ({
  id: Ids.EventId.make(`${eventPrefixFor(targetThreadId)}_event_compacted`),
  thread_id: targetThreadId,
  sequence: 0,
  version: 1,
  created_at: 7,
  type: "context.compacted",
  data: {
    summary: "native actor compacted summary",
    tail_start_sequence: 4,
    trigger: "manual",
    tokens_before: 42,
    model: "native-actor-test",
  },
})

const turnFailed = (sequence: number, thread: Ids.ThreadId, turn: Ids.TurnId): Event.TurnFailed => ({
  id: Ids.EventId.make(`native_agent_loop_failed_${sequence}`),
  thread_id: thread,
  turn_id: turn,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.failed",
  data: { error: { kind: "cancelled", message: "cancelled" } },
})

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("Could not allocate port")))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })

const waitForEngine = async (url: string) => {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`)
      if (response.status < 500) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Rivet engine did not start at ${url}`)
}

const waitForThreadActor = async (url: string) => {
  const readyThreadId = Ids.ThreadId.make(`native_actor_ready_${runId}`)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      await Effect.runPromise(
        ThreadClient.getEvents({ thread_id: readyThreadId, after_sequence: 0 }).pipe(Effect.provide(clientLayer(url))),
      )
      return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`ThreadActor runner did not become ready at ${url}`)
}

const collectLiveTail = async (url: string, targetThreadId: Ids.ThreadId) => {
  const client = createClient({ endpoint: url })
  const conn = threadEventConnection(client.getOrCreate("ThreadActor", targetThreadId).connect())
  const liveEvents: Array<Event.Event> = []
  try {
    const expected = waitForLiveEvents(liveEvents, 6)
    const unsubscribe = conn.on("threadEvent", (encodedEvent) => {
      liveEvents.push(Codec.decode(Event.Event)(encodedEvent))
    })
    try {
      await conn.ready
      await conn.action("GetEvents", [{ thread_id: targetThreadId, after_sequence: 0 }])
      await Effect.runPromise(
        ThreadClient.startTurn({
          thread_id: targetThreadId,
          workspace_id: workspaceId,
          content: "Reply with READY",
          mode: "rush",
        }).pipe(Effect.provide(clientLayer(url))),
      )
      await expected
      const replayed = await waitForReplay(url, targetThreadId, 6)
      return { liveEvents, replayed }
    } finally {
      unsubscribe()
    }
  } finally {
    await conn.dispose()
    await client.dispose()
  }
}

const threadEventConnection = (input: object) => {
  const ready = Reflect.get(input, "ready")
  const on = Reflect.get(input, "on")
  const action = Reflect.get(input, "action")
  const dispose = Reflect.get(input, "dispose")
  if (
    !isPromiseLike(ready) ||
    typeof on !== "function" ||
    typeof action !== "function" ||
    typeof dispose !== "function"
  ) {
    throw new Error("Rivet actor connection does not expose the expected live-tail API")
  }
  return {
    ready,
    on: (eventName: "threadEvent", callback: (encodedEvent: unknown) => void) => {
      const unsubscribe = on(eventName, callback)
      if (typeof unsubscribe !== "function") {
        throw new Error("Rivet actor event subscription did not return an unsubscribe function")
      }
      return unsubscribe
    },
    action: (name: "GetEvents", args: ReadonlyArray<unknown>) => {
      const result = action({ name, args })
      if (!isPromiseLike(result)) {
        throw new Error("Rivet actor connection action did not return a promise")
      }
      return result
    },
    dispose: () => {
      const result = dispose()
      if (!isPromiseLike(result)) {
        throw new Error("Rivet actor connection dispose did not return a promise")
      }
      return result
    },
  }
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "then") === "function"

const waitForLiveEvents = async (events: ReadonlyArray<Event.Event>, count: number) => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (events.length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Expected ${count} live events`)
}

const waitForReplay = async (url: string, targetThreadId: Ids.ThreadId, count: number) => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const events = await Effect.runPromise(
      ThreadClient.getEvents({ thread_id: targetThreadId, after_sequence: 0 }).pipe(Effect.provide(clientLayer(url))),
    )
    if (events.length >= count) return events
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Expected ${count} replayed events`)
}

const waitForActiveSnapshot = async (url: string, targetThreadId: Ids.ThreadId, userId: Ids.UserId) => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = await Effect.runPromise(
      ThreadClient.ensureThread({
        thread_id: targetThreadId,
        workspace_id: workspaceId,
        identity: verifiedIdentity(userId),
      }).pipe(Effect.provide(clientLayer(url))),
    )
    if (snapshot.active_turn_status === "active") return snapshot
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Expected active actor snapshot")
}
