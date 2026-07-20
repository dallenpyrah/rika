import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Policy from "../tool-policy"
import * as WebSearch from "../web-search"
import { Result, ToolFailure } from "./result"
export const Request = Schema.Struct({
  _tag: Schema.tag("WebSearch"),
  objective: WebSearch.Objective,
  searchQueries: WebSearch.SearchQueries,
  kind: Schema.optionalKey(WebSearch.Capability),
  strategy: Schema.optionalKey(WebSearch.Strategy),
  githubSearchType: Schema.optionalKey(WebSearch.GithubSearchType),
})
export const tool = Tool.make("web_search", {
  description: "Search across configured sources. Use code for semantic examples and github for exact GitHub search.",
  parameters: Schema.Struct({
    objective: WebSearch.Objective,
    searchQueries: WebSearch.SearchQueries,
    kind: Schema.optionalKey(WebSearch.Capability),
    strategy: Schema.optionalKey(WebSearch.Strategy),
    githubSearchType: Schema.optionalKey(WebSearch.GithubSearchType),
  }),
  success: Result,
  failure: ToolFailure,
  failureMode: "return",
})
export const registration = Policy.register(
  tool,
  Policy.allow("safe", 30_000, 40_000, {
    family: "direct",
    action: "web-search",
    activeLabel: "Web Search",
    completeLabel: "Web Search",
    outputDisplay: "hidden",
    counter: "web search",
  }),
)
