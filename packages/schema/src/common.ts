import { Schema } from "effect"

export const ProtocolVersion = Schema.Literal(1).annotate({ identifier: "Rika.ProtocolVersion" })
export type ProtocolVersion = typeof ProtocolVersion.Type

export const JsonValue = Schema.Json.annotate({ identifier: "Rika.JsonValue" })
export type JsonValue = typeof JsonValue.Type

export const Metadata = Schema.Record(Schema.String, JsonValue).annotate({ identifier: "Rika.Metadata" })
export type Metadata = typeof Metadata.Type

export const TimestampMillis = Schema.Int.annotate({ identifier: "Rika.TimestampMillis" })
export type TimestampMillis = typeof TimestampMillis.Type

export const LineRange = Schema.Struct({
  start_line: Schema.Int,
  end_line: Schema.Int,
}).annotate({ identifier: "Rika.LineRange" })
export interface LineRange extends Schema.Schema.Type<typeof LineRange> {}
