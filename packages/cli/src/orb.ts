import { IdGenerator, Time } from "@rika/core"
import { OrbManager, SandboxClient } from "@rika/orb"
import { ArtifactStore, OrbStore } from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Ids, Orb, Remote } from "@rika/schema"
import { OrbMirror } from "@rika/server"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import * as Args from "./args"
import * as Input from "./input"
import * as Output from "./output"

export class OrbError extends Schema.TaggedErrorClass<OrbError>()("CliOrbError", {
  message: Schema.String,
  exit_code: Schema.Int,
}) {}

export type RunError =
  | ArtifactStore.ArtifactStoreError
  | Client.SdkError
  | Input.InputError
  | OrbError
  | OrbManager.OrbProvisionError
  | OrbMirror.RunError
  | OrbStore.OrbStoreError

export type ClientFactory = (endpointUrl: string, token: string) => Client.Interface

export interface Interface {
  readonly executeCommand: (command: Args.OrbCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Orb") {}

export const layerWithClientFactory = (clientFactory: ClientFactory) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const output = yield* Output.Service
      const input = yield* Input.Service
      const orbs = yield* OrbStore.Service
      const artifacts = yield* ArtifactStore.Service
      const orbManager = yield* OrbManager.Service
      const orbMirror = yield* OrbMirror.Service
      const idGenerator = yield* IdGenerator.Service
      const time = yield* Time.Service

      const promptForKill = Effect.fn("Cli.Orb.promptForKill")(function* (orbId: Ids.OrbId, threadId: Ids.ThreadId) {
        yield* output.stderr(`Kill orb ${orbId} for thread ${threadId}? [y/N]`)
        const line = yield* Stream.runHead(input.lines).pipe(
          Effect.mapError((error) => new OrbError({ message: error.message, exit_code: 1 })),
        )
        const answer = Option.getOrElse(line, () => "")
          .trim()
          .toLowerCase()
        return answer === "y" || answer === "yes"
      })

      const readFinalDiff = Effect.fn("Cli.Orb.readFinalDiff")(function* (orb: Orb.OrbRecord) {
        const endpoint = yield* orbs.endpointCredentials(orb.orb_id)
        if (endpoint === undefined) {
          return { status: "unavailable", reason: `Orb ${orb.orb_id} has no endpoint credentials` } as const
        }
        const flushResult = yield* Effect.result(orbMirror.flush(orb.orb_id))
        if (flushResult._tag === "Failure") {
          if (isRemoteFlushUnavailable(flushResult.failure)) {
            return { status: "unavailable", reason: failureMessage(flushResult.failure) } as const
          }
          return yield* Effect.fail(flushResult.failure)
        }
        const changes = yield* clientFactory(endpoint.endpoint_url, endpoint.token).orbChanges()
        return { status: "available", changes } as const
      })

      const storeFinalDiff = Effect.fn("Cli.Orb.storeFinalDiff")(function* (
        orb: Orb.OrbRecord,
        changes: Remote.OrbChangesResponse,
      ) {
        const artifactId = Ids.ArtifactId.make(yield* idGenerator.next("artifact"))
        const createdAt = yield* time.nowMillis
        yield* artifacts.put({
          id: artifactId,
          thread_id: orb.thread_id,
          kind: "orb-final-diff",
          title: "Orb final diff",
          content: changes,
          created_at: createdAt,
        })
        return undefined
      })

      const bestEffortFinalDiff = Effect.fn("Cli.Orb.bestEffortFinalDiff")(function* (orb: Orb.OrbRecord) {
        const result = yield* readFinalDiff(orb)
        if (result.status === "unavailable") {
          yield* output.stderr(`warning: skipped final orb diff for ${orb.thread_id}: ${result.reason}`)
          return undefined
        }
        yield* storeFinalDiff(orb, result.changes)
        return undefined
      })

      const markKilled = Effect.fn("Cli.Orb.markKilled")(function* (record: Orb.OrbRecord) {
        if (record.sandbox_id === null) {
          yield* output.stderr(`warning: orb ${record.orb_id} has no sandbox; marking orb killed locally`)
          return yield* orbs.setStatus(record.orb_id, "killed")
        }
        return yield* orbManager.kill(record.orb_id)
      })

      return Service.of({
        executeCommand: Effect.fn("Cli.Orb.executeCommand")(function* (command: Args.OrbCommand) {
          switch (command.action) {
            case "list": {
              const records = yield* orbs.list()
              yield* output.stdout("thread\tproject\tstatus\tlast_active_at")
              yield* Effect.forEach(records, (record) => output.stdout(formatRecord(record)), { discard: true })
              return 0
            }
            case "kill": {
              const threadId = yield* requireThreadId(command)
              const orb = yield* orbs.getByThread(threadId)
              if (orb === undefined) {
                return yield* new OrbError({ message: `No orb found for thread ${threadId}`, exit_code: 2 })
              }
              if (command.force !== true) {
                const confirmed = yield* promptForKill(orb.orb_id, threadId)
                if (!confirmed) {
                  yield* output.stderr("aborted")
                  return 1
                }
              }
              yield* bestEffortFinalDiff(orb)
              yield* markKilled(orb)
              return 0
            }
          }
          return yield* new OrbError({ message: "Unsupported orb action", exit_code: 2 })
        }),
      })
    }),
  )

export const layer = layerWithClientFactory((endpointUrl, token) =>
  Client.make(Client.fetchTransport({ base_url: endpointUrl, token })),
)

export const executeCommand = Effect.fn("Cli.Orb.executeCommand.call")(function* (command: Args.OrbCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: RunError) => {
  if (error instanceof OrbError) return error.message
  if (error instanceof Client.SdkError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const requireThreadId = (command: Args.OrbCommand) =>
  command.thread_id === undefined
    ? Effect.fail(new OrbError({ message: `Thread id is required for ${command.action}`, exit_code: 2 }))
    : Effect.succeed(command.thread_id)

const formatRecord = (record: Orb.OrbRecord) =>
  `${record.thread_id}\t${record.project_id}\t${record.status}\t${record.last_active_at}`

const failureMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const remoteFlushSdkOperations = new Set(["streamJson", "subscribeThreadEvents"])

const isRemoteFlushUnavailable = (error: unknown) => {
  if (error instanceof Client.SdkError) {
    return error.status === undefined && remoteFlushSdkOperations.has(error.operation)
  }
  if (error instanceof OrbMirror.OrbMirrorError) return error.operation === "endpoint"
  if (error instanceof SandboxClient.SandboxClientError) return true
  return false
}
