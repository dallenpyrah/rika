import { Common, Tool } from "@rika/schema"
import type { Tool as AiTool } from "effect/unstable/ai"
import type * as ToolRegistry from "./tool-registry"

export const TurnToolAccess = Tool.TurnToolAccess
export type TurnToolAccess = Tool.TurnToolAccess

export const defaultTurnToolAccess: TurnToolAccess = "full"

export const readOnlyToolNames = [
  "semantic_search",
  "semantic_search_status",
  "fffind",
  "fff_glob",
  "fff_directory_search",
  "ffgrep",
  "fff_multi_grep",
  "fff_health",
  "ast_grep_outline",
  "read",
] as const

const readOnlyToolSet = new Set<string>(readOnlyToolNames)

export const turnToolAccess = (access: TurnToolAccess | undefined): TurnToolAccess => access ?? defaultTurnToolAccess

export const isReadOnlyTurn = (access: TurnToolAccess | undefined): boolean => turnToolAccess(access) === "read-only"

export const isReadOnlyToolName = (name: string): boolean => readOnlyToolSet.has(name)

export const allowedToolNames = (access: TurnToolAccess | undefined): ReadonlyArray<string> | undefined =>
  isReadOnlyTurn(access) ? readOnlyToolNames : undefined

export const filterDescriptors = (
  descriptors: ReadonlyArray<ToolRegistry.Descriptor>,
  access: TurnToolAccess | undefined,
): ReadonlyArray<ToolRegistry.Descriptor> => {
  if (!isReadOnlyTurn(access)) return descriptors
  return descriptors.filter((descriptor) => isReadOnlyToolName(descriptor.name))
}

export const filterTools = (
  tools: ReadonlyArray<AiTool.Any>,
  access: TurnToolAccess | undefined,
): ReadonlyArray<AiTool.Any> => {
  if (!isReadOnlyTurn(access)) return tools
  return tools.filter((tool) => isReadOnlyToolName(tool.name))
}

export const metadataToolAccess = (metadata: Common.Metadata | undefined): TurnToolAccess | undefined => {
  const access = metadata?.tool_access
  if (access === "full" || access === "read-only") return access
  return undefined
}

export const metadata = (access: TurnToolAccess | undefined): Common.Metadata =>
  isReadOnlyTurn(access) ? { tool_access: "read-only" } : {}
