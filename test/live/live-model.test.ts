import { Agent, ModelRegistry, Tool, Toolkit } from "@batonfx/core"
import { withOpenAiCompatible } from "@batonfx/providers/openai-compat"
import { resolve } from "../../packages/runtime/src/agent-profiles"
import { describe, expect, it } from "@effect/vitest"
import { Config, Effect, Option, Redacted, Schema } from "effect"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const config = Effect.runSync(
  Config.all({
    enabled: Config.boolean("RIKA_LIVE_MODEL_TEST").pipe(Config.withDefault(false)),
    apiKey: Config.option(Config.redacted("RIKA_MODEL_API_KEY")),
    baseUrl: Config.option(Config.string("RIKA_MODEL_BASE_URL")),
    model: Config.option(Config.string("RIKA_MODEL_ID")),
  }),
)

const missing = [
  ...(config.enabled ? [] : ["RIKA_LIVE_MODEL_TEST=1"]),
  ...(Option.isSome(config.apiKey) ? [] : ["RIKA_MODEL_API_KEY"]),
  ...(Option.isSome(config.baseUrl) ? [] : ["RIKA_MODEL_BASE_URL"]),
  ...(Option.isSome(config.model) ? [] : ["RIKA_MODEL_ID"]),
]
const skipReason = `live model suite disabled: missing ${missing.join(", ")}`
const live = config.enabled && missing.length === 0
const liveIt = (name: string, test: () => Effect.Effect<void, unknown, never>) =>
  live ? it.effect(name, test) : it.skip(`${name} (${skipReason})`, test)
const apiKey = Option.getOrElse(config.apiKey, () => Redacted.make("unavailable"))
const baseUrl = Option.getOrElse(config.baseUrl, () => "http://127.0.0.1")
const model = Option.getOrElse(config.model, () => "unavailable")
const selection = { provider: "configured", model }
const modelLayer = withOpenAiCompatible({ provider: "configured", model, baseUrl, apiKey: Config.succeed(apiKey) })

const normalize = (result: Agent.Result) => ({
  nonEmpty: result.text.trim().length > 0,
  turns: result.turns,
  toolCalls: result.transcript.content
    .filter((part) => part.role === "assistant")
    .flatMap((part) => part.content)
    .filter((part) => part.type === "tool-call")
    .map((part) => part.name),
})

const run = <Tools extends Record<string, Tool.Any>>(
  agent: Agent.Agent<Tools, true>,
  prompt: string,
  history?: Agent.RunOptions["history"],
) => Agent.generate(agent, { prompt, ...(history === undefined ? {} : { history }) }).pipe(Effect.provide(modelLayer))

describe("configured OpenAI-compatible live model", () => {
  liveIt("completes a short turn", () =>
    Effect.gen(function* () {
      const result = yield* run(Agent.make("live-smoke", { model: selection }), "Reply with exactly: rika-live-ok")
      expect(result.text.toLowerCase()).toContain("rika-live-ok")
      expect(normalize(result)).toMatchObject({ nonEmpty: true, turns: 1, toolCalls: [] })
    }),
  )

  liveIt("uses a coding tool in a disposable repository", () =>
    Effect.acquireUseRelease(
      Effect.tryPromise(() => mkdtemp(join(tmpdir(), "rika-live-"))),
      (directory) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise(() => mkdir(join(directory, ".git")))
          const createFile = Tool.make("create_file", {
            description: "Create one UTF-8 file in the disposable repository",
            parameters: Schema.Struct({ path: Schema.String, content: Schema.String }),
            success: Schema.String,
          })
          const toolkit = Toolkit.make(createFile)
          const agent = Agent.make("live-coder", {
            model: selection,
            instructions:
              "Use create_file exactly once. Create answer.ts containing export const answer = 42 followed by a newline.",
            toolkit,
          })
          const result = yield* run(agent, "Implement the requested answer.ts file.").pipe(
            Effect.provide(
              toolkit.toLayer({
                create_file: ({ path, content }) =>
                  Effect.tryPromise(() => writeFile(join(directory, path), content, { flag: "wx" })).pipe(
                    Effect.as(path),
                    Effect.orDie,
                  ),
              }),
            ),
          )
          const content = yield* Effect.tryPromise(() => readFile(join(directory, "answer.ts"), "utf8"))
          expect(content).toBe("export const answer = 42\n")
          expect(normalize(result).toolCalls).toEqual(["create_file"])
        }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    ),
  )

  liveIt("retains multi-turn context", () =>
    Effect.gen(function* () {
      const agent = Agent.make("live-multi-turn", { model: selection })
      const first = yield* run(agent, "Remember the nonce cedar-417. Reply only acknowledged.")
      const second = yield* run(agent, "What nonce did I ask you to remember? Reply only with it.", first.transcript)
      expect(second.text.toLowerCase()).toContain("cedar-417")
      expect(normalize(second).nonEmpty).toBe(true)
    }),
  )

  liveIt("runs the named Oracle child profile", () =>
    Effect.gen(function* () {
      const profile = resolve("Oracle", selection)
      const result = yield* run(profile.agent, "Without using tools, reply with exactly the profile name Oracle.")
      expect(profile.preset.metadata.product_profile).toBe("Oracle")
      expect(result.text.toLowerCase()).toContain("oracle")
    }),
  )

  liveIt("detects workflow capability without inventing support", () =>
    Effect.gen(function* () {
      const registry = yield* ModelRegistry.Service
      const registrations = yield* registry.registrations
      const workflowSupported = registrations.some((registration) => registration.metadata?.workflow === true)
      expect({
        modelReachable: registrations.some((registration) => registration.provider === "configured"),
        workflowSupported,
      }).toEqual({ modelReachable: true, workflowSupported: false })
    }).pipe(Effect.provide(modelLayer)),
  )
})
