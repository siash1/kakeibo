/**
 * List-price constants for cost estimation (spec 5.6).
 *
 * Every cost figure kakeibo prints is labelled "list-price estimate" because
 * that is what it is: these are published rack rates, not what the account is
 * actually billed (credits, committed-use discounts and free tiers all move the
 * real number). The point of tracking them is *relative* — comparing a cached
 * turn against an uncached one, or Flash against Pro — which list prices capture
 * faithfully even when the absolute figure is wrong.
 *
 * Source: https://cloud.google.com/vertex-ai/generative-ai/pricing, global
 * endpoint, text modality, read 2026-08-09. `cacheStorage` is USD per million
 * token-hours; Google does not publish it on the main pricing table, so the
 * documented $1.00 (flash tier) / $4.50 (pro tier) range is used and flagged.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  in: number
  /** USD per million output tokens (thinking tokens bill at this rate). */
  out: number
  /** USD per million input tokens served from cache. */
  cachedIn: number
  /** USD per million token-hours of explicit cache storage. */
  cacheStorage: number
}

export const PRICING: Record<string, ModelPrice> = {
  'gemini-3.6-flash': { in: 1.5, out: 7.5, cachedIn: 0.15, cacheStorage: 1.0 },
  'gemini-3.5-flash': { in: 1.5, out: 9.0, cachedIn: 0.15, cacheStorage: 1.0 },
  'gemini-3.5-flash-lite': { in: 0.3, out: 2.5, cachedIn: 0.03, cacheStorage: 1.0 },
  'gemini-3.1-pro-preview': { in: 2.0, out: 12.0, cachedIn: 0.2, cacheStorage: 4.5 },
  'gemini-3.1-flash-lite': { in: 0.25, out: 1.5, cachedIn: 0.025, cacheStorage: 1.0 },
  'gemini-3-flash-preview': { in: 0.5, out: 3.0, cachedIn: 0.05, cacheStorage: 1.0 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5, cachedIn: 0.03, cacheStorage: 1.0 },
  'gemini-2.5-flash-lite': { in: 0.1, out: 0.4, cachedIn: 0.01, cacheStorage: 1.0 },
  'gemini-2.5-pro': { in: 1.25, out: 10.0, cachedIn: 0.13, cacheStorage: 4.5 },
}

/** Used when a model ID is not in the table, so cost is 0 rather than NaN. */
const UNKNOWN: ModelPrice = { in: 0, out: 0, cachedIn: 0, cacheStorage: 0 }

export function priceFor(model: string): ModelPrice {
  if (PRICING[model]) return PRICING[model]
  // Vertex sometimes serves "gemini-3.6-flash-001" for the alias "gemini-3.6-flash".
  const base = Object.keys(PRICING).find((k) => model.startsWith(k))
  return base ? PRICING[base]! : UNKNOWN
}

export interface CostInput {
  model: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  /** Explicit-cache storage, prorated: tokens held x hours held. */
  cacheStorageTokenHours?: number
}

/**
 * Cached tokens are billed at the discounted rate *instead of* the input rate,
 * so they are subtracted from the billable input count rather than added on top.
 */
export function estimateCostUsd(input: CostInput): number {
  const p = priceFor(input.model)
  const uncachedInput = Math.max(0, input.inputTokens - input.cachedTokens)
  const cost =
    (uncachedInput / 1_000_000) * p.in +
    (input.cachedTokens / 1_000_000) * p.cachedIn +
    (input.outputTokens / 1_000_000) * p.out +
    ((input.cacheStorageTokenHours ?? 0) / 1_000_000) * p.cacheStorage
  return round6(cost)
}

/** What the same call would have cost with no cache hit — the savings baseline. */
export function estimateUncachedCostUsd(input: CostInput): number {
  const p = priceFor(input.model)
  return round6((input.inputTokens / 1_000_000) * p.in + (input.outputTokens / 1_000_000) * p.out)
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(6)}`
  return `$${n.toFixed(4)}`
}
