import { Schema } from "effect"

const StringRecord = Schema.Record(Schema.String, Schema.String)

export interface CommandServerConfig extends Schema.Schema.Type<typeof CommandServerConfig> {}
export const CommandServerConfig = Schema.Struct({
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(StringRecord),
  cwd: Schema.optional(Schema.String),
  includeTools: Schema.optional(Schema.Array(Schema.String)),
  excludeTools: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Rika.Mcp.CommandServerConfig" })

export interface RemoteServerConfig extends Schema.Schema.Type<typeof RemoteServerConfig> {}
export const RemoteServerConfig = Schema.Struct({
  url: Schema.String,
  headers: Schema.optional(StringRecord),
  includeTools: Schema.optional(Schema.Array(Schema.String)),
  excludeTools: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Rika.Mcp.RemoteServerConfig" })

export type ServerConfig = CommandServerConfig | RemoteServerConfig
export const ServerConfig = Schema.Union([CommandServerConfig, RemoteServerConfig]).annotate({
  identifier: "Rika.Mcp.ServerConfig",
})

export interface ServerMap extends Schema.Schema.Type<typeof ServerMap> {}
export const ServerMap = Schema.Record(Schema.String, ServerConfig).annotate({ identifier: "Rika.Mcp.ServerMap" })
