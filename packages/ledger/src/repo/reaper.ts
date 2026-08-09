import { and, eq, lt, sql } from 'drizzle-orm'
import { user } from '../auth-schema'
import { adminDb } from '../db'
import { rateLimits, suspendedTurns } from '../schema'

/**
 * The nightly sweep (spec §2, §8).
 *
 * Three kinds of row outlive their usefulness, and only one of them is covered
 * by the `owner_id` cascade:
 *
 *  1. **Anonymous users past their retention window.** The site promises, in
 *     the UI at the point of upload, that an anonymous ledger is deleted after
 *     24 hours. That promise is kept here or not at all. Signing in clears the
 *     expiry by construction — the row stops being an anonymous user.
 *  2. **Abandoned suspended turns.** These cascade away with their owner, so
 *     an anonymous visitor's are handled by (1); a signed-in visitor who never
 *     answered a confirmation leaves one behind forever.
 *  3. **Yesterday's rate-limit counters.** The only table in the schema with no
 *     `owner_id` at all, which is deliberate — and means nothing else will ever
 *     delete a row from it.
 */

/** Anonymous retention, stated in the UI and enforced here. */
const ANONYMOUS_TTL_MS = 24 * 60 * 60_000

export interface ReapResult {
  anonymousUsers: number
  suspendedTurns: number
  rateLimits: number
}

export async function reap(options: { anonymousTtlMs?: number } = {}): Promise<ReapResult> {
  const cutoff = new Date(Date.now() - (options.anonymousTtlMs ?? ANONYMOUS_TTL_MS))
  const db = adminDb()

  // `is_anonymous = true`, not `is not false`: the column is nullable, and a
  // null is a signed-in user whose row predates the plugin's default. Deleting
  // on a null would take a real account with it.
  const users = await db
    .delete(user)
    .where(and(eq(user.isAnonymous, true), lt(user.createdAt, cutoff)))
    .returning({ id: user.id })

  // Whatever survived the cascade above: a signed-in visitor who closed the tab
  // on a confirmation card.
  const turns = await db
    .delete(suspendedTurns)
    .where(lt(suspendedTurns.expiresAt, new Date()))
    .returning({ id: suspendedTurns.id })

  const limits = await db
    .delete(rateLimits)
    .where(lt(rateLimits.windowStart, sql`current_date`))
    .returning({ key: rateLimits.key })

  return {
    anonymousUsers: users.length,
    suspendedTurns: turns.length,
    rateLimits: limits.length,
  }
}
