import { Cause, Effect, Fiber, FileSystem, Option, Path, Queue, Ref, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { Sandbox } from "./process"
import * as ResourceSampler from "./resource-sampler"

export class PackagedFanOutError extends Schema.TaggedErrorClass<PackagedFanOutError>()("PackagedFanOutError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface AttachResult {
  readonly index: number
  readonly clientPid: number
  readonly hostPid: number | undefined
  readonly connectionId: string | undefined
  readonly owner: boolean
  readonly error?: string
}

export interface CleanupResult {
  readonly detected: ReadonlyArray<ResourceSampler.OrphanProcess>
  readonly orphans: ReadonlyArray<ResourceSampler.OrphanProcess>
}

export interface PackagedFanOutRun {
  readonly hostPid: number
  readonly attachments: ReadonlyArray<AttachResult>
  readonly hostResources: ResourceSampler.ProcessResources
  readonly teardown: Effect.Effect<CleanupResult, PackagedFanOutError | ResourceSampler.ResourceSamplingError>
}

interface PackagedClient {
  readonly rootPid: number
  readonly handle: ChildProcessSpawner.ChildProcessHandle
  readonly input: Queue.Queue<string, Cause.Done>
  readonly stdout: Ref.Ref<ReadonlyArray<string>>
  readonly stderr: Ref.Ref<ReadonlyArray<string>>
  readonly ioFibers: ReadonlyArray<Fiber.Fiber<void, never>>
}

const failure = (operation: string, cause: unknown) => PackagedFanOutError.make({ operation, message: String(cause) })

const appendBounded = (ref: Ref.Ref<ReadonlyArray<string>>, line: string) =>
  Ref.update(ref, (lines) => (lines.length >= 256 ? [...lines.slice(1), line] : [...lines, line]))

const clientScript = `
"$1" doctor &
client_pid=$!
wait "$client_pid"
status=$?
attempt=0
while [ "$attempt" -lt 200 ]; do
  found=0
  for file in "$2"/resident-*.open.jsonl; do
    [ -e "$file" ] || continue
    name=\${file##*/}
    host_pid=\${name%.open.jsonl}
    host_pid=\${host_pid##*-}
    if kill -0 "$host_pid" 2>/dev/null; then
      printf 'RIKA_STRESS_PROCESS %s %s\\n' "$client_pid" "$host_pid"
      found=$((found + 1))
    fi
  done
  [ "$found" -gt 0 ] && break
  attempt=$((attempt + 1))
  sleep 0.01
done
exit "$status"
`.trim()

const startClient = Effect.fn("PackagedFanOut.startClient")(function* (
  context: Sandbox,
  environment: Readonly<Record<string, string | undefined>>,
  diagnostics: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const sampler = yield* ResourceSampler.Service
  const input = yield* Queue.bounded<string, Cause.Done>(32)
  const stdoutQueue = yield* Queue.bounded<string, Cause.Done>(256)
  const stderrQueue = yield* Queue.bounded<string, Cause.Done>(256)
  const stdout = yield* Ref.make<ReadonlyArray<string>>([])
  const stderr = yield* Ref.make<ReadonlyArray<string>>([])
  const handle = yield* spawner
    .spawn(
      ChildProcess.make("sh", ["-c", clientScript, "rika-stress-client", context.binary, diagnostics], {
        cwd: context.workspace,
        env: environment,
        extendEnv: true,
        detached: true,
        stdin: { stream: Stream.fromQueue(input).pipe(Stream.encodeText), endOnDone: true },
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    .pipe(Effect.mapError((cause) => failure("spawn packaged client", cause)))
  yield* sampler.track([Number(handle.pid)])
  const drain = (
    stream: Stream.Stream<Uint8Array, unknown>,
    queue: Queue.Queue<string, Cause.Done>,
    errors: Ref.Ref<ReadonlyArray<string>>,
  ) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Queue.offer(queue, line)),
      Effect.catchCause((cause) => appendBounded(errors, Cause.pretty(cause))),
      Effect.ensuring(Queue.end(queue)),
    )
  const collect = (queue: Queue.Queue<string, Cause.Done>, target: Ref.Ref<ReadonlyArray<string>>) =>
    Stream.fromQueue(queue).pipe(Stream.runForEach((line) => appendBounded(target, line)))
  const ioFibers = yield* Effect.all(
    [
      Effect.forkScoped(drain(handle.stdout, stdoutQueue, stderr)),
      Effect.forkScoped(drain(handle.stderr, stderrQueue, stderr)),
      Effect.forkScoped(collect(stdoutQueue, stdout)),
      Effect.forkScoped(collect(stderrQueue, stderr)),
    ],
    { concurrency: 4 },
  )
  return {
    rootPid: Number(handle.pid),
    handle,
    input,
    stdout,
    stderr,
    ioFibers,
  } satisfies PackagedClient
})

const annotation = (value: unknown, name: string): unknown => {
  if (typeof value !== "object" || value === null || !("annotations" in value)) return undefined
  const annotations = value.annotations
  return typeof annotations === "object" && annotations !== null && name in annotations
    ? (annotations as Record<string, unknown>)[name]
    : undefined
}

const message = (value: unknown) =>
  typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
    ? value.message
    : undefined

const decodedLogLines = (text: string) =>
  text
    .split("\n")
    .map((line) => Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(line))
    .filter(Option.isSome)
    .map((value) => value.value)

const clientLog = Effect.fn("PackagedFanOut.clientLog")(function* (diagnostics: string, pid: number) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const names = yield* fileSystem
    .readDirectory(diagnostics)
    .pipe(Effect.mapError((cause) => failure(`read client diagnostics for ${pid}`, cause)))
  const name = names.find(
    (candidate) =>
      candidate.startsWith("client-") &&
      (candidate.endsWith(`-${pid}.jsonl`) || candidate.endsWith(`-${pid}.open.jsonl`)),
  )
  if (name === undefined) return yield* failure(`read client diagnostics for ${pid}`, "client log is missing")
  return yield* fileSystem
    .readFileString(path.join(diagnostics, name))
    .pipe(Effect.mapError((cause) => failure(`read client diagnostics for ${pid}`, cause)))
})

const processObservations = (lines: ReadonlyArray<string>) =>
  lines.flatMap((line) => {
    const matched = line.match(/^RIKA_STRESS_PROCESS (\d+) (\d+)$/)
    return matched === null ? [] : [{ clientPid: Number(matched[1]), hostPid: Number(matched[2]) }]
  })

const awaitClient = Effect.fn("PackagedFanOut.awaitClient")(function* (
  client: PackagedClient,
  index: number,
  diagnostics: string,
) {
  const exit = yield* Effect.result(
    client.handle.exitCode.pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          client.handle
            .kill({ killSignal: "SIGKILL" })
            .pipe(
              Effect.ignore,
              Effect.andThen(Effect.fail(failure(`wait for packaged client ${client.rootPid}`, "client timed out"))),
            ),
      }),
      Effect.mapError((cause) => failure(`wait for packaged client ${client.rootPid}`, cause)),
    ),
  )
  yield* Queue.end(client.input)
  yield* Effect.forEach(client.ioFibers, Fiber.join, { concurrency: 4, discard: true })
  const observations = processObservations(yield* Ref.get(client.stdout))
  const observation = observations.length === 1 ? observations[0] : undefined
  const clientPid = observation?.clientPid ?? client.rootPid
  const stderr = (yield* Ref.get(client.stderr)).join("\n")
  const logResult = yield* Effect.result(clientLog(diagnostics, clientPid))
  if (logResult._tag === "Failure") {
    return {
      index,
      clientPid,
      hostPid: observation?.hostPid,
      connectionId: undefined,
      owner: false,
      error: [
        ...(observation === undefined ? [`client recorded ${observations.length} resident process observations`] : []),
        logResult.failure.message,
      ].join("\n"),
    } satisfies AttachResult
  }
  const events = decodedLogLines(logResult.success)
  const adopted = events.find((event) => message(event) === "resident.startup.adopted")
  const ready = events.find((event) => message(event) === "resident.connection.ready")
  const adoptedPid = annotation(adopted, "rika.resident.startup.pid")
  const connectionId = annotation(ready, "rika.resident.connection.id")
  const hostPid = observation?.hostPid
  const problems = [
    ...(exit._tag === "Failure" ? [String(exit.failure)] : []),
    ...(exit._tag === "Success" && Number(exit.success) !== 0 ? [`client exited ${exit.success}`] : []),
    ...(observation === undefined ? [`client recorded ${observations.length} resident process observations`] : []),
    ...(typeof connectionId === "string" ? [] : ["client did not record a connection id"]),
    ...(hostPid === undefined ? ["client did not record a host pid"] : []),
    ...(stderr.length === 0 ? [] : [stderr]),
  ]
  return {
    index,
    clientPid,
    hostPid,
    connectionId: typeof connectionId === "string" ? connectionId : undefined,
    owner: typeof adoptedPid === "number" && adoptedPid === hostPid,
    ...(problems.length === 0 ? {} : { error: problems.join("\n") }),
  } satisfies AttachResult
})

export const runPackagedFanOut = Effect.fn("PackagedFanOut.run")(function* (
  context: Sandbox,
  options: {
    readonly clientCount: number
    readonly spawnConcurrency?: number
  },
) {
  if (!Number.isInteger(options.clientCount) || options.clientCount < 1 || options.clientCount > 200)
    return yield* failure("validate client count", "clientCount must be an integer from 1 through 200")
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const sampler = yield* ResourceSampler.Service
  const home = context.env.HOME
  if (home === undefined) return yield* failure("prepare packaged clients", "sandbox HOME is missing")
  const state = path.join(home, ".rika")
  const diagnostics = path.join(state, "diagnostics")
  yield* fileSystem
    .makeDirectory(state, { recursive: true })
    .pipe(Effect.mapError((cause) => failure("create packaged client state", cause)))
  const environment = {
    ...context.env,
    RIKA_DATABASE: path.join(state, "rika.db"),
    RIKA_RELAY_DATABASE: path.join(state, "relay.db"),
    RIKA_INTERNAL_RESIDENT_GRACE: "120000",
  }
  const tornDown = yield* Ref.make(false)
  const hostResourcesRef = yield* Ref.make<ResourceSampler.ProcessResources | undefined>(undefined)
  const teardown = Effect.gen(function* () {
    if (yield* Ref.get(tornDown)) return { detected: [], orphans: [] } satisfies CleanupResult
    const cleanup = yield* sampler.terminateOrphans
    const resources = yield* Ref.get(hostResourcesRef)
    if (resources !== undefined) yield* resources.stop
    if (cleanup.remaining.length > 0)
      return yield* failure(
        "tear down packaged fan-out",
        `orphan processes remain: ${cleanup.remaining.map((entry) => `${entry.pid} ${entry.status} ${entry.command}`).join(", ")}`,
      )
    yield* Ref.set(tornDown, true)
    return { detected: cleanup.detected, orphans: cleanup.remaining } satisfies CleanupResult
  })
  yield* Effect.addFinalizer(() => teardown.pipe(Effect.ignore))

  const firstClient = yield* startClient(context, environment, diagnostics)
  const first = yield* awaitClient(firstClient, 0, diagnostics)
  if (first.error !== undefined || first.hostPid === undefined || first.connectionId === undefined)
    return yield* failure("attach daemon-owning client", first.error ?? "owner attachment was incomplete")
  yield* sampler.track([first.hostPid])
  const hostResources = yield* sampler.watch(first.hostPid)
  yield* Ref.set(hostResourcesRef, hostResources)
  const joiners = yield* Effect.forEach(
    Array.from({ length: options.clientCount - 1 }, (_, index) => index + 1),
    (index) =>
      Effect.gen(function* () {
        const client = yield* startClient(context, environment, diagnostics)
        return yield* awaitClient(client, index, diagnostics)
      }),
    { concurrency: options.spawnConcurrency ?? 16 },
  )
  const attachments = [first, ...joiners].toSorted((left, right) => left.index - right.index)
  const attachmentProblems = attachments.filter((attachment) => attachment.error !== undefined)
  if (attachmentProblems.length > 0)
    return yield* failure(
      "attach packaged clients",
      attachmentProblems.map((attachment) => `client ${attachment.index}: ${attachment.error}`).join("\n"),
    )
  const observedHostPids = new Set(attachments.map((attachment) => attachment.hostPid))
  if (observedHostPids.size !== 1 || !observedHostPids.has(first.hostPid))
    return yield* failure(
      "keep resident host stable",
      `clients observed resident pids ${[...observedHostPids].join(", ")}`,
    )
  if ((yield* sampler.snapshot(first.hostPid)) === undefined)
    return yield* failure("keep resident host stable", `resident ${first.hostPid} exited before fan-out completed`)
  return {
    hostPid: first.hostPid,
    attachments,
    hostResources,
    teardown,
  } satisfies PackagedFanOutRun
})
