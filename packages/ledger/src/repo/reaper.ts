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

  /*
   * The UTC date, not `current_date` — CLAUDE.md rule 11, and the one place
   * Plan C's sweep of this bug missed.
   *
   * `quota.ts` writes `window_start` from `today()`, which is
   * `new Date().toISOString().slice(0, 10)` and therefore always the UTC day.
   * This delete compared it against a bare `current_date`, which Postgres
   * evaluates in the *session* timezone — `Asia/Kolkata` on the development
   * machine. For the 5.5 hours between local midnight and UTC midnight the two
   * disagree by a day, so a counter written today (UTC) sorts as "before
   * today" (local) and the sweep deletes it.
   *
   * The effect was not a stale row left behind, which is the harmless
   * direction: it was every per-IP counter for the current UTC day being wiped
   * at local midnight, handing the whole IPv4 space a fresh daily allowance
   * 5.5 hours early. `reaper.test.ts` has always asserted this correctly and
   * only fails inside that window, which is why it stayed green until a run
   * happened to cross it.
   *
   * A third definition rather than an import: `admin.ts` and `quota.ts` each
   * pin midnight UTC as a `timestamptz` instant, and `window_start` is a bare
   * `date`, so the expression is genuinely different rather than duplicated.
   */
  const limits = await db
    .delete(rateLimits)
    .where(lt(rateLimits.windowStart, sql`(now() at time zone 'utc')::date`))
    .returning({ key: rateLimits.key })

  return {
    anonymousUsers: users.length,
    suspendedTurns: turns.length,
    rateLimits: limits.length,
  }
}
