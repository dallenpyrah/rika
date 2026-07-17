import * as Transcript from "@rika/transcript/schema"
import { Schema } from "effect"
import { Turn, TurnId } from "./turn-schema"

export interface Entry {
  readonly turn: Turn
  readonly unit: Transcript.Unit
  readonly projectionRevision: number
  readonly projectionModelPhase: number
  readonly projectionCostUsd?: number
}

export const EntrySchema = Schema.Struct({
  turn: Turn,
  unit: Transcript.Unit,
  projectionRevision: Schema.Finite,
  projectionModelPhase: Schema.Finite,
  projectionCostUsd: Schema.optionalKey(Schema.Finite),
})

export interface PageCursor {
  readonly createdAt: number
  readonly turnId: TurnId
  readonly sequence: number
  readonly part: number
  readonly key: string
}

export const PageCursor = Schema.Struct({
  createdAt: Schema.Finite,
  turnId: TurnId,
  sequence: Schema.Finite,
  part: Schema.Finite,
  key: Schema.String,
})
