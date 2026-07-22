import { Effect, Schema } from "effect"
import { ThreadId } from "../thread-schema"
import { ExecutionExtensionPin, ExecutionRoutePin, PromptPart, Status, Turn, TurnId } from "../turn-schema"
import {
  PageCursor,
  QueueFull,
  QueuedTurnUnavailable,
  RepositoryError,
  defaultPageSize,
  maximumPageSize,
} from "./contract"

export const isTerminalStatus = (status: Status) =>
  status === "completed" || status === "failed" || status === "cancelled"

export const Row = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  prompt: Schema.String,
  status: Schema.String,
  last_cursor: Schema.NullOr(Schema.String),
  extension_pin_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
  execution_route_json: Schema.String,
  review_fan_out_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  prompt_parts_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
})

export const QueueStateRow = Schema.Struct({
  thread_id: Schema.String,
  revision: Schema.Finite,
  queued_count: Schema.Finite,
  wake_generation: Schema.Finite,
  wake_pending: Schema.Finite,
})

export const ExtensionPinJson = Schema.fromJsonString(ExecutionExtensionPin)
export const PromptPartsJson = Schema.fromJsonString(Schema.Array(PromptPart))
export const ExecutionRouteJson = Schema.fromJsonString(ExecutionRoutePin)
export const repositoryError = (error: unknown) => RepositoryError.make({ message: String(error) })
export const submissionError = (error: unknown) => (Schema.is(QueueFull)(error) ? error : repositoryError(error))
export const takeQueuedError = (error: unknown) =>
  Schema.is(QueuedTurnUnavailable)(error) ? error : repositoryError(error)
export const missing = (id: TurnId) => RepositoryError.make({ message: `Turn ${id} does not exist` })
export const queuedTurnUnavailable = (id: TurnId) =>
  QueuedTurnUnavailable.make({ turnId: id, message: `Turn ${id} is not queued` })
export const clone = (turn: Turn): Turn => structuredClone(turn)
export const pageSize = (limit: number | undefined) =>
  Math.min(maximumPageSize, Math.max(1, Math.floor(limit ?? defaultPageSize)))
export const cursorFor = (turn: Turn | undefined): PageCursor | undefined =>
  turn === undefined ? undefined : { createdAt: turn.createdAt, id: turn.id }
export const decodeQueueState = (row: unknown) =>
  Schema.decodeUnknownEffect(QueueStateRow)(row).pipe(Effect.mapError(repositoryError))
export const decode = (row: unknown) =>
  Effect.gen(function* () {
    const value = yield* Schema.decodeUnknownEffect(Row)(row)
    const status = yield* Schema.decodeUnknownEffect(Status)(value.status)
    const extensionPin =
      value.extension_pin_json == null
        ? undefined
        : yield* Schema.decodeUnknownEffect(ExtensionPinJson)(value.extension_pin_json)
    const promptParts =
      value.prompt_parts_json == null
        ? undefined
        : yield* Schema.decodeUnknownEffect(PromptPartsJson)(value.prompt_parts_json)
    const executionRoute = yield* Schema.decodeUnknownEffect(ExecutionRouteJson)(value.execution_route_json)
    return {
      id: TurnId.make(value.id),
      threadId: ThreadId.make(value.thread_id),
      prompt: value.prompt,
      ...(promptParts === undefined ? {} : { promptParts }),
      status,
      ...(value.last_cursor === null ? {} : { lastCursor: value.last_cursor }),
      ...(extensionPin === undefined ? {} : { extensionPin }),
      executionRoute,
      ...(value.review_fan_out_id == null ? {} : { reviewFanOutId: value.review_fan_out_id }),
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }
  }).pipe(Effect.mapError(repositoryError))

export const encodeExtensionPin = (pin: ExecutionExtensionPin) =>
  Schema.encodeEffect(ExtensionPinJson)(pin).pipe(Effect.mapError(repositoryError))
