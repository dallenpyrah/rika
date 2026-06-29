import { Schedule, Stream } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import type * as Provider from "./provider"

export const isTransient = (error: unknown): boolean =>
  AiError.isAiError(error) && error.isRetryable && error.reason._tag !== "InvalidOutputError"

const transientSchedule = Schedule.exponential("250 millis", 2).pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(3)),
  Schedule.collectWhile((metadata) => isTransient(metadata.input)),
)

export const middleware: Provider.StreamMiddleware = () => (stream) => Stream.retry(stream, transientSchedule)
