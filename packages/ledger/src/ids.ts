import { createHash } from 'node:crypto'

/**
 * A deterministic UUID derived from a name (RFC 4122 v5 shape, SHA-256 based).
 *
 * The seed generator is deterministic in everything except primary keys, and
 * random keys are enough to break two things that matter: replay fixtures key
 * off request bytes, and tool results carry transaction IDs, so a reseed
 * produces a "different" conversation and every fixture misses. Eval checks
 * that assert on specific transactions have the same problem.
 *
 * Real user imports keep database-generated random IDs — this is only for the
 * synthetic corpus, where reproducibility is the whole point.
 */
export function deterministicUuid(namespace: string, name: string): string {
  const hash = createHash('sha256').update(`${namespace}:${name}`).digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  // Version 5, RFC 4122 variant.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const SEED_NAMESPACE = 'kakeibo.seed.transaction'
