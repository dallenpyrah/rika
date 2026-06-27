import { Schema } from "effect"

export const decode = <const S extends Schema.Decoder<unknown>>(schema: S) => Schema.decodeUnknownSync(schema)
export const encode = <const S extends Schema.Encoder<unknown>>(schema: S) => Schema.encodeSync(schema)
