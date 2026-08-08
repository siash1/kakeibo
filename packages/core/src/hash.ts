import { createHash } from 'node:crypto'

/**
 * Deterministic JSON: object keys sorted at every depth, arrays left alone.
 *
 * Two jobs depend on this being exact:
 *  1. Fixture keys — the same logical request must hash identically across runs
 *     and machines, or replay silently misses (spec 8.2).
 *  2. Cache-prefix debugging — byte-diffing two serialised requests is how you
 *     hunt a cache invalidator (spec 5.5), and that only works if serialisation
 *     itself is not a source of noise.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const out: Record<string, unknown> = {}
  for (const [k, v] of entries) out[k] = sortDeep(v)
  return out
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function hashRequest(value: unknown): string {
  return sha256(stableStringify(value)).slice(0, 32)
}
