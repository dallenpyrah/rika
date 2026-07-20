import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { WebSearch } from "../src"
import { provide } from "./test-layer"

const input = { objective: "Find current docs", searchQueries: ["current docs"] } as const
const result = { url: "https://example.com", title: null, publishedAt: null, excerpts: ["match"] }
const makeProvider = (
  id: string,
  priority: number,
  capabilities: ReadonlyArray<WebSearch.Capability> = ["web"],
  search: WebSearch.SearchProvider["search"] = () => Effect.succeed({ results: [result] }),
): WebSearch.SearchProvider => ({ id, priority, capabilities: new Set(capabilities), search })

const response = (httpRequest: HttpClientRequest.HttpClientRequest, body: unknown, status = 200, headers = {}) =>
  HttpClientResponse.fromWeb(
    httpRequest,
    new Response(Schema.encodeSync(Schema.UnknownFromJsonString)(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  )

const clientLayer = (
  run: (httpRequest: HttpClientRequest.HttpClientRequest) => HttpClientResponse.HttpClientResponse,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((httpRequest) => Effect.succeed(run(httpRequest))),
  )

const body = (httpRequest: HttpClientRequest.HttpClientRequest) => {
  if (httpRequest.body._tag !== "Uint8Array") throw new Error("Expected JSON body")
  return Schema.decodeSync(Schema.UnknownFromJsonString)(new TextDecoder().decode(httpRequest.body.body))
}

describe("WebSearch registry", () => {
  it.effect("selects by priority and compares at most three providers without deduplication", () =>
    Effect.gen(function* () {
      const search = WebSearch.make([
        makeProvider("low", 1),
        makeProvider("high", 3),
        makeProvider("middle", 2),
        makeProvider("fourth", 0),
      ])
      expect((yield* search.search(input)).map((outcome) => outcome.provider)).toEqual(["high"])
      expect((yield* search.search({ ...input, strategy: "compare" })).map((outcome) => outcome.provider)).toEqual([
        "high",
        "middle",
        "low",
      ])
    }),
  )

  it.effect("honors explicit providers for auto, reports partial failures, and fails when all fail", () =>
    Effect.gen(function* () {
      const failed = makeProvider("failed", 2, ["web"], () =>
        Effect.fail(WebSearch.ProviderFailure.make({ provider: "failed", kind: "timeout", message: "late" })),
      )
      const search = WebSearch.make([makeProvider("ok", 1), failed])
      const partial = yield* search.search({ ...input, providers: ["failed", "ok"] })
      expect(partial.map((outcome) => outcome.provider)).toEqual(["failed", "ok"])
      expect(partial[0]?.error?.kind).toBe("timeout")
      const all = yield* Effect.flip(search.search({ ...input, providers: ["failed"] }))
      expect(all._tag).toBe("WebSearchExecutionError")
      const unavailable = yield* Effect.flip(search.search({ ...input, providers: ["missing"] }))
      expect(unavailable.message).toContain("unavailable")
      const incapable = yield* Effect.flip(search.search({ ...input, kind: "code", providers: ["ok"] }))
      expect(incapable.message).toContain("does not support 'code'")
      const excess = yield* Effect.flip(search.search({ ...input, providers: ["a", "b", "c", "d"] }))
      expect(excess.message).toContain("At most 3")
    }),
  )
})

describe("WebSearch HTTP providers", () => {
  it.effect("builds and normalizes Exa web and code requests", () => {
    const captured: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function* () {
      const web = yield* WebSearch.exa({ apiKey: Redacted.make("exa"), baseUrl: "https://exa.test" })
      const code = yield* WebSearch.exaCode({ apiKey: Redacted.make("exa"), baseUrl: "https://exa.test" })
      const webResult = yield* web.search({ ...input, kind: "web", strategy: "auto" })
      const codeResult = yield* code.search({ ...input, kind: "code", strategy: "auto" })
      expect(captured.map(({ url }) => url)).toEqual(["https://exa.test/search", "https://exa.test/context"])
      expect(body(captured[0]!)).toMatchObject({ type: "fast", contents: { highlights: true } })
      expect(webResult.results?.[0]).toMatchObject({ url: "https://exa.test/result", excerpts: ["highlight"] })
      expect(codeResult.content).toBe("formatted code context")
    }).pipe(
      provide(
        clientLayer((httpRequest) => {
          captured.push(httpRequest)
          return httpRequest.url.endsWith("/context")
            ? response(httpRequest, { response: "formatted code context" })
            : response(httpRequest, {
                results: [{ url: "https://exa.test/result", title: "Result", highlights: ["highlight"] }],
              })
        }),
      ),
    )
  })

  it.effect("builds Firecrawl GitHub-category and GitHub REST requests", () => {
    const captured: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function* () {
      const firecrawl = yield* WebSearch.firecrawl({ apiKey: Redacted.make("fire"), baseUrl: "https://fire.test" })
      const github = yield* WebSearch.github({ apiKey: Redacted.make("github"), baseUrl: "https://github.test" })
      const fireResult = yield* firecrawl.search({ ...input, kind: "github", strategy: "auto" })
      const githubResult = yield* github.search({
        ...input,
        kind: "github",
        strategy: "auto",
        githubSearchType: "commits",
      })
      expect(body(captured[0]!)).toMatchObject({ categories: ["github"] })
      expect(captured[1]?.url).toContain("/search/commits?q=")
      expect(captured[1]?.headers["x-github-api-version"]).toBe("2022-11-28")
      expect(fireResult.results?.[0]?.excerpts).toEqual(["repository description"])
      expect(githubResult.results?.[0]?.excerpts).toEqual(["fragment", "commit body"])
    }).pipe(
      provide(
        clientLayer((httpRequest) => {
          captured.push(httpRequest)
          return httpRequest.url.includes("fire.test")
            ? response(httpRequest, { data: { web: [{ url: "https://repo", description: "repository description" }] } })
            : response(httpRequest, {
                items: [
                  {
                    html_url: "https://github.test/commit",
                    text_matches: [{ fragments: ["fragment"] }],
                    body: "commit body",
                  },
                ],
              })
        }),
      ),
    )
  })

  it.effect("normalizes authentication, rate-limit, and malformed response failures", () =>
    Effect.gen(function* () {
      const missing = yield* WebSearch.parallel({})
      expect((yield* Effect.flip(missing.search({ ...input, kind: "web", strategy: "auto" }))).kind).toBe(
        "authentication",
      )
      const limited = yield* WebSearch.github({ apiKey: Redacted.make("key"), baseUrl: "https://github.test" })
      expect((yield* Effect.flip(limited.search({ ...input, kind: "github", strategy: "auto" }))).kind).toBe(
        "rate-limit",
      )
    }).pipe(
      provide(
        clientLayer((httpRequest) =>
          response(httpRequest, { message: "limit" }, 403, { "x-ratelimit-remaining": "0" }),
        ),
      ),
    ),
  )
})
