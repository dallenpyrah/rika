import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"

type Message = Record<string, unknown>

const root = mkdtempSync(join(tmpdir(), "rika-resident-protocol-"))
const canonical = realpathSync(root)
const identity = createHash("sha256").update(`default\0${canonical}`).digest("hex")
const port = 20_000 + (Number.parseInt(identity.slice(0, 8), 16) % 30_000)
const url = `ws://127.0.0.1:${port}/resident`
const host = Bun.spawn(["bun", "test/fixtures/resident-host.ts"], {
  cwd: join(import.meta.dir, "apps/rika"),
  env: {
    ...process.env,
    RIKA_TEST_RESIDENT_DATA_ROOT: root,
    RIKA_TEST_RESIDENT_GRACE: "1000",
    RIKA_TEST_RESIDENT_STARTUP_HOLD: "30000",
    RIKA_TEST_RESIDENT_OUTBOUND_CAPACITY: "4",
  },
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
})

const deadline = Date.now() + 10_000
while (!(await Bun.file(join(root, "resident.token")).exists())) {
  if (Date.now() >= deadline) throw new Error("host token timeout")
  await Bun.sleep(10)
}
const token = readFileSync(join(root, "resident.token"), "utf8").trim()
await Bun.sleep(500)

const connect = async () => {
  const messages: Message[] = []
  const waiters: Array<(message: Message) => void> = []
  let closeResolve!: (code: number) => void
  const closed = new Promise<number>((resolve) => (closeResolve = resolve))
  const socket = new WebSocket(url)
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as Message
    console.error("MESSAGE", JSON.stringify(message))
    const waiter = waiters.shift()
    if (waiter === undefined) messages.push(message)
    else waiter(message)
  }
  socket.onclose = ({ code }) => closeResolve(code)
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error("websocket failed"))
  })
  const next = () =>
    messages.length > 0 ? Promise.resolve(messages.shift()!) : new Promise<Message>((resolve) => waiters.push(resolve))
  const nonce = crypto.randomUUID()
  socket.send(
    JSON.stringify({ family: "rika-resident", identity, token, clientNonce: nonce, clientKind: "interactive" }),
  )
  const accepted = await next()
  if (accepted._tag !== "accepted") throw new Error(`not accepted: ${JSON.stringify(accepted)}`)
  return { socket, next, closed, connectionId: String(accepted.connectionId) }
}

const start = async () => {
  const connection = await connect()
  const requestId = crypto.randomUUID()
  connection.socket.send(
    JSON.stringify({
      _tag: "operation",
      requestId,
      input: { _tag: "Interactive", prompt: ["overflow-watch"], ephemeral: false, workspace: import.meta.dir },
    }),
  )
  let started: Message | undefined
  while (started === undefined) {
    const message = await connection.next()
    if (message._tag === "interactive-started") started = message
  }
  return {
    ...connection,
    requestId,
    sessionId: String(started.sessionId),
    feedGeneration: String(started.feedGeneration),
  }
}

const route = (session: Awaited<ReturnType<typeof start>>) => ({
  connectionId: session.connectionId,
  requestId: session.requestId,
  sessionId: session.sessionId,
  feedGeneration: session.feedGeneration,
})

try {
  const feed = await start()
  const first = new Array<Message>()
  while (first.length < 4) {
    const message = await feed.next()
    if (message._tag === "interactive-feed-event") first.push(message)
  }
  feed.socket.send(JSON.stringify({ _tag: "interactive-feed-ack", ...route(feed), throughSequence: 2 }))
  let barrier: Message | undefined
  while (barrier === undefined) {
    const message = await feed.next()
    if (message._tag === "interactive-feed-resync") barrier = message
  }
  const barrierSequence = Number(barrier.sequence)
  feed.socket.send(
    JSON.stringify({ _tag: "interactive-feed-replay", ...route(feed), afterSequence: barrierSequence - 1 }),
  )
  let replayed: Message | undefined
  while (replayed === undefined) {
    const message = await feed.next()
    if (message._tag === "interactive-feed-resync" && message.sequence === barrier.sequence) replayed = message
  }
  feed.socket.send(JSON.stringify({ _tag: "interactive-feed-ack", ...route(feed), throughSequence: barrierSequence }))
  feed.socket.send(JSON.stringify({ _tag: "interactive-feed-replay", ...route(feed), afterSequence: 0 }))
  let recovery: Message | undefined
  while (recovery === undefined) {
    const message = await feed.next()
    if (message._tag === "interactive-feed-resync" && Number(message.sequence) > barrierSequence) recovery = message
  }
  feed.socket.send(
    JSON.stringify({ _tag: "interactive-feed-ack", ...route(feed), throughSequence: Number(recovery.sequence) }),
  )
  console.log(
    JSON.stringify({
      feed: "pass",
      firstSequences: first.map((message) => message.sequence),
      barrierSequence,
      replayedBarrierSequence: replayed.sequence,
      recoverySequence: recovery.sequence,
    }),
  )
  feed.socket.close()

  const stale = await start()
  stale.socket.send(
    JSON.stringify({
      _tag: "interactive-feed-ack",
      ...route(stale),
      feedGeneration: `${stale.feedGeneration}-stale`,
      throughSequence: 0,
    }),
  )
  console.log(JSON.stringify({ staleGenerationClose: await stale.closed }))

  const command = await start()
  command.socket.send(
    JSON.stringify({
      _tag: "interactive-command",
      ...route(command),
      commandSequence: 1,
      command: { _tag: "ReadQueue", threadId: "thread" },
    }),
  )
  let completed = false
  while (!completed) {
    const message = await command.next()
    completed = message._tag === "interactive-command-completed" && message.commandSequence === 1
  }
  command.socket.send(
    JSON.stringify({
      _tag: "interactive-command",
      ...route(command),
      commandSequence: 1,
      command: { _tag: "ReadQueue", threadId: "thread" },
    }),
  )
  console.log(JSON.stringify({ duplicateCommandClose: await command.closed }))
} finally {
  host.kill("SIGKILL")
  await host.exited
  rmSync(root, { recursive: true, force: true })
}
