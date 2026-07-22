import type { ResidentCommandContext } from "./resident-client-command"
import { Deferred, Effect, Fiber, Queue } from "effect"

const handleResidentCommand = (command: string, context: ResidentCommandContext) => {
  const { connection, path, fs, dataRoot, emit, done, workspace } = context
  if (command === "fragment-burst")
    return Effect.gen(function* () {
      const lengths = yield* Effect.forEach(
        ["large-event-a", "large-event-b"],
        (kind) =>
          Effect.gen(function* () {
            const messages = yield* Queue.unbounded<string>()
            let length = 0
            yield* connection.run(
              { _tag: "Interactive", prompt: [kind], ephemeral: false, workspace },
              {
                interactive: (_, session) =>
                  Effect.gen(function* () {
                    const feed = yield* Effect.forkChild(
                      session.events((event) => {
                        if (event._tag === "ExecutionFailed") Queue.offerUnsafe(messages, event.message)
                      }),
                    )
                    const message = yield* Queue.take(messages)
                    length = message.length
                    yield* Fiber.interrupt(feed)
                  }),
              },
            )
            return length
          }),
        { concurrency: 2 },
      )
      yield* emit({ type: "fragment-burst-completed", text: lengths.join(",") })
    }).pipe(Effect.catch((error) => emit({ type: "fragment-burst-failed", error: error.message })))
  if (command === "overflow-interactive")
    return Effect.gen(function* () {
      const tags = new Array<string>()
      const completed = yield* Queue.unbounded<void>()
      const exit = yield* Effect.exit(
        connection.run(
          { _tag: "Interactive", prompt: ["overflow-events"], ephemeral: false, workspace },
          {
            interactive: (_, session) =>
              Effect.gen(function* () {
                const feed = yield* Effect.forkChild(
                  session.events((event) => {
                    tags.push(event._tag)
                    if (event._tag === "TranscriptResyncRequired") Queue.offerUnsafe(completed, undefined)
                  }),
                )
                yield* Queue.take(completed)
                yield* Fiber.interrupt(feed)
              }),
          },
        ),
      )
      yield* emit({
        type: exit._tag === "Failure" ? "overflow-failed" : "overflow-completed",
        callbacks: tags.length,
        tag: tags.at(-1),
        tags,
        ...(exit._tag === "Failure" ? { error: String(exit.cause) } : {}),
      })
    })
  if (command === "slow-consumer")
    return Effect.gen(function* () {
      const tags = new Array<string>()
      const completed = yield* Queue.unbounded<void>()
      const exit = yield* Effect.exit(
        connection.run(
          { _tag: "Interactive", prompt: ["slow-consumer-events"], ephemeral: false, workspace },
          {
            interactive: (_, session) =>
              Effect.gen(function* () {
                yield* Effect.sleep("350 millis")
                const feed = yield* Effect.forkChild(
                  session.events((event) => {
                    tags.push(event._tag === "TranscriptPatched" ? event.event.type : event._tag)
                    if (event._tag === "TranscriptResyncRequired") Queue.offerUnsafe(completed, undefined)
                  }),
                )
                yield* Queue.take(completed)
                yield* Fiber.interrupt(feed)
              }),
          },
        ),
      )
      yield* emit({
        type: exit._tag === "Failure" ? "slow-consumer-failed" : "slow-consumer-completed",
        callbacks: tags.length,
        tags,
        ...(exit._tag === "Failure" ? { error: String(exit.cause) } : {}),
      })
    })
  if (command === "queue-overflow-interactive")
    return Effect.gen(function* () {
      const tags = new Array<string>()
      const completed = yield* Queue.unbounded<void>()
      const exit = yield* Effect.exit(
        connection.run(
          { _tag: "Interactive", prompt: ["queue-overflow-events"], ephemeral: false, workspace },
          {
            interactive: (_, session) =>
              Effect.gen(function* () {
                const feed = yield* Effect.forkChild(
                  session.events((event) => {
                    tags.push(event._tag)
                    if (event._tag === "QueueResyncRequired") Queue.offerUnsafe(completed, undefined)
                  }),
                )
                yield* Queue.take(completed)
                yield* Fiber.interrupt(feed)
              }),
          },
        ),
      )
      yield* emit({
        type: exit._tag === "Failure" ? "queue-overflow-failed" : "queue-overflow-completed",
        callbacks: tags.length,
        tag: tags.at(-1),
        tags,
        ...(exit._tag === "Failure" ? { error: String(exit.cause) } : {}),
      })
    })
  if (command === "overflow-watch")
    return Effect.gen(function* () {
      const tags = new Array<string>()
      const completed = yield* Queue.unbounded<void>()
      const exit = yield* Effect.exit(
        connection.run(
          { _tag: "Interactive", prompt: ["overflow-watch"], ephemeral: false, workspace },
          {
            interactive: (_, session) =>
              Effect.gen(function* () {
                const feed = yield* Effect.forkChild(
                  session.events((event) => {
                    tags.push(event._tag)
                    if (event._tag === "ThreadsListed" && tags.includes("TranscriptResyncRequired"))
                      Queue.offerUnsafe(completed, undefined)
                  }),
                )
                yield* Queue.take(completed)
                yield* Fiber.interrupt(feed)
              }),
          },
        ),
      )
      yield* emit({
        type: "overflow-watch-finished",
        outcome: exit._tag,
        tags,
      })
    })
  if (command === "blocking-interactive")
    return connection
      .run(
        { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
        { interactive: () => emit({ type: "interactive-callback" }).pipe(Effect.andThen(Effect.never)) },
      )
      .pipe(Effect.ensuring(emit({ type: "blocking-completed" })), Effect.forkChild, Effect.asVoid)
  if (command === "feed-takeover")
    return connection
      .run(
        { _tag: "Interactive", prompt: ["feed-takeover"], ephemeral: false, workspace },
        {
          interactive: (_, session) =>
            Effect.gen(function* () {
              const first = yield* Effect.forkChild(session.events(() => undefined))
              yield* Effect.sleep("50 millis")
              yield* Fiber.interrupt(first)
              const events = yield* Queue.unbounded<string>()
              const second = yield* Effect.forkChild(session.events((value) => Queue.offerUnsafe(events, value._tag)))
              yield* emit({ type: "replacement-feed-event", tag: yield* Queue.take(events) })
              yield* Fiber.interrupt(second)
            }),
        },
      )
      .pipe(Effect.andThen(emit({ type: "feed-takeover-completed" })))
  if (command === "output")
    return connection
      .run({ _tag: "Doctor" }, { stdout: (text) => emit({ type: "output", text }) })
      .pipe(Effect.andThen(emit({ type: "output-completed" })))
  if (command === "oversized-output")
    return Effect.gen(function* () {
      let text = ""
      let callbacks = 0
      yield* connection.run(
        {
          _tag: "Run",
          prompt: ["oversized-output"],
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        },
        {
          stdout: (chunk) =>
            Effect.sync(() => {
              text += chunk
              callbacks += 1
            }),
        },
      )
      yield* connection.ping
      yield* emit({
        type: "oversized-output-completed",
        text: String(text.length),
        callbacks,
        outcome: text === `${"x".repeat(1_100_000)}\n` ? "exact" : "mismatch",
      })
    })
  if (command === "delayed")
    return connection
      .run({
        _tag: "Run",
        prompt: ["delayed"],
        ephemeral: false,
        streamJson: false,
        streamJsonInput: false,
        streamJsonThinking: false,
      })
      .pipe(
        Effect.andThen(emit({ type: "delayed-completed" })),
        Effect.catch((error) => emit({ type: "delayed-failed", error: error.message })),
      )
  if (command === "cancel-delayed")
    return Effect.gen(function* () {
      const operation = yield* Effect.forkChild(
        connection.run({
          _tag: "Run",
          prompt: ["delayed"],
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        }),
      )
      while (!(yield* fs.exists(path.join(dataRoot, "delayed-work-starts.log")).pipe(Effect.orDie)))
        yield* Effect.sleep("1 millis")
      yield* Fiber.interrupt(operation)
      while (!(yield* fs.exists(path.join(dataRoot, "delayed-work-finalizations.log")).pipe(Effect.orDie)))
        yield* Effect.sleep("1 millis")
      yield* connection.ping
      yield* emit({ type: "cancelled-delayed" })
    })
  if (command === "rejected")
    return connection.run({ _tag: "Doctor" }).pipe(
      Effect.andThen(emit({ type: "rejected-work-completed" })),
      Effect.catch((error) => emit({ type: "rejected-work", error: error.message })),
    )
  if (command === "close")
    return connection.close.pipe(
      Effect.andThen(emit({ type: "closed" })),
      Effect.andThen(Deferred.succeed(done, undefined)),
    )
  return undefined
}

export const internal = { handleResidentCommand }
