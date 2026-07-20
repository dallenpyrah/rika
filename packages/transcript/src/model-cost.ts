import type { Cost, Model, ModelCost } from "@opencode-ai/models"
import { generatedAt, providers } from "@opencode-ai/models/snapshot"

export const pricingVersion = `models.dev:${generatedAt}:calculator-1`

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const nonNegativeFinite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

const token = (value: Record<string, unknown>, key: string): number | undefined => nonNegativeFinite(value[key])

const hasMalformedToken = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
  keys.some((key) => value[key] !== undefined && value[key] !== null && token(value, key) === undefined)

const modelFor = (provider: string, model: string, modelSnapshot: string): Model | undefined => {
  const catalog = providers[provider]?.models
  if (catalog === undefined) return undefined
  return catalog[modelSnapshot] ?? catalog[model]
}

const modeCost = (model: Model, serviceTier: string): Cost | undefined =>
  Object.values(model.experimental?.modes ?? {}).find(
    (mode) => record(mode.provider?.body).service_tier === serviceTier && mode.cost !== undefined,
  )?.cost

const contextCost = (cost: ModelCost, inputTokens: number): Cost =>
  (cost.tiers ?? [])
    .toSorted((left, right) => right.tier.size - left.tier.size)
    .find((tier) => inputTokens >= tier.tier.size) ?? cost

const costFor = (model: Model, serviceTier: string, inputTokens: number): Cost | undefined => {
  if (serviceTier.length > 0 && serviceTier !== "default") return modeCost(model, serviceTier)
  return model.cost === undefined ? undefined : contextCost(model.cost, inputTokens)
}

const totalInput = (
  total: number | undefined,
  uncached: number | undefined,
  cacheRead: number | undefined,
  cacheWrite: number | undefined,
): number | undefined => total ?? (uncached !== undefined && cacheRead !== undefined && cacheWrite !== undefined
  ? uncached + cacheRead + cacheWrite
  : undefined)

export const usageCostUsd = (value: Record<string, unknown>): number | undefined => {
  for (const key of ["cost_usd", "costUsd"]) {
    const candidate = nonNegativeFinite(value[key])
    if (candidate !== undefined) return candidate
  }

  const tokenKeys = [
    "input_tokens",
    "input_tokens_uncached",
    "input_tokens_cache_read",
    "input_tokens_cache_write",
    "output_tokens",
  ]
  if (hasMalformedToken(value, tokenKeys)) return undefined

  const input = token(value, "input_tokens")
  const reportedUncached = token(value, "input_tokens_uncached")
  const cacheRead = token(value, "input_tokens_cache_read")
  const cacheWrite = token(value, "input_tokens_cache_write")
  const output = token(value, "output_tokens")
  const accountedInput = [reportedUncached, cacheRead, cacheWrite].reduce<number>(
    (sum, count) => sum + (count ?? 0),
    0,
  )
  if (input !== undefined && accountedInput > input) return undefined
  if (
    input !== undefined &&
    accountedInput < input &&
    reportedUncached === undefined &&
    (cacheRead === undefined || cacheWrite === undefined)
  )
    return undefined

  const uncached =
    reportedUncached ??
    (input !== undefined && cacheRead !== undefined && cacheWrite !== undefined
      ? input - cacheRead - cacheWrite
      : undefined)
  const inputForTier = totalInput(input, uncached, cacheRead, cacheWrite)
  if (inputForTier === undefined) return undefined

  const provider = typeof value.provider === "string" ? value.provider : ""
  const configuredModel = typeof value.model === "string" ? value.model : ""
  const snapshot = typeof value.model_snapshot === "string" ? value.model_snapshot : ""
  const model = modelFor(provider, configuredModel, snapshot)
  if (model === undefined) return undefined
  const serviceTier = typeof value.service_tier === "string" ? value.service_tier : ""
  const cost = costFor(model, serviceTier, inputForTier)
  if (cost === undefined) return undefined
  if ((uncached ?? 0) > 0 && cost.input === undefined) return undefined
  if ((cacheRead ?? 0) > 0 && cost.cache_read === undefined) return undefined
  if ((output ?? 0) > 0 && cost.output === undefined) return undefined
  if (uncached === undefined && cacheRead === undefined && output === undefined) return undefined

  return (
    ((uncached ?? 0) * cost.input + (cacheRead ?? 0) * (cost.cache_read ?? 0) + (output ?? 0) * cost.output) /
    1_000_000
  )
}
