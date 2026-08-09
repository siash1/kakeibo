import { env } from '@kakeibo/core/env'
import { sha256 } from '@kakeibo/core/hash'
import { and, eq, gte, sql } from 'drizzle-orm'
import { user } from '../auth-schema'
import { adminDb } from '../db'
import type { OwnerId } from '../owner'
import { rateLimits, traceRuns } from '../schema'
import { isLiveChatPaused } from './flags'

/**
 * Cost control (spec §5).
 *
 * Five checks, cheapest first, all computed from tables that already exist:
 * `trace_runs` records owner and cost per turn, `user` carries the blocked
 * flag, and `operator_flags` is a single-row lookup. The first two — the
 * live-chat pause and the per-owner block — are the operator's kill switches
 * from §9.4, not the four cost layers §5 originally numbered; they sit ahead
 * of the three quota layers because a paused or blocked check costs nothing to
 * ask and answers before any of the others need to run. There are no rollup
 * tables — at ~148 turns a day a direct scan stays fast for years, and a
 * rollup is a cache to invalidate for no present gain.
 *
 * Everything here runs on `adminDb`. The global cap is a sum across every
 * owner, which is exactly what the row-level security policies forbid, and the
 * blocked check reads `user`, which the application role has no privileges on
 * at all. This module is read-only apart from the address counter it increments
 * on the way through.
 */

export type QuotaReason = 'paused' | 'blocked' | 'owner_quota' | 'ip_quota' | 'daily_cap'

export type QuotaVerdict =
  | { allowed: true; used: { owner: number; ip: number } }
  | { allowed: false; reason: QuotaReason }

export interface QuotaInput {
  owner: OwnerId
  /** From `hashIp`. Absent in local development, where there is no address. */
  ipHash?: string | undefined
  isAnonymous: boolean
  /**
   * `message` — a new turn, which costs one message against both quotas.
   * `resume` — picking a suspended turn back up. It was already charged when it
   * started, and a turn that cannot be finished leaves a write dangling with no
   * way to answer for it. Blocking and the daily cap still apply, because
   * resuming makes fresh model calls.
   */
  kind: 'message' | 'resume'
}

/**
 * Salted, dated hash of a raw address.
 *
 * The salt means the stored key is not a rainbow-table lookup of the IPv4
 * space, and the date means yesterday's keys cannot be correlated with today's
 * — so the table cannot be used to follow one visitor across days, only to
 * count them within one.
 */
export function hashIp(ip: string, day = today()): string {
  return sha256(`${ip}|${env().RATE_LIMIT_SALT}|${day}`)
}

/**
 * Today, as the JS `Date` sees it: always a UTC date, because `toISOString`
 * is always UTC regardless of the host's local zone.
 *
 * `spendToday` and `messagesToday` below are pinned to `UTC_DAY_START` so
 * their SQL bound lands on the same day this returns. Left as a bare
 * `current_date`, Postgres evaluates it in the *session* timezone — on this
 * database `Asia/Kolkata` — and casts it to a `timestamptz` at that zone's
 * midnight, not UTC's. That would put this function and those two queries on
 * different days for the 5.5 hours between session-local midnight and UTC
 * midnight, which is exactly the bug this comment used to assert did not
 * exist.
 */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Midnight at the start of today, UTC, as a `timestamptz` instant.
 *
 * Duplicated from `admin.ts`'s `UTC_DAY_START` rather than imported from it:
 * that module is the RLS-bypass door (see its file comment), and importing
 * from it here would give the admin-containment test a second reason to name
 * every module that reads it, for a one-line expression that is cheaper to
 * copy than to share.
 */
const UTC_DAY_START = sql`(((now() at time zone 'utc')::date)::timestamp at time zone 'utc')`

/**
 * True for a `trace_runs` row that is a turn a visitor actually made.
 *
 * Duplicated from `admin.ts`'s `IS_VISITOR_RUN` for the same reason
 * `UTC_DAY_START` above is duplicated rather than imported: `admin.ts` is the
 * RLS-bypass door, and this is a one-line expression, cheaper to copy than to
 * give the containment test another module to name.
 *
 * It exists here because `admin.ts`'s operator actions (spec §9.4) each write
 * a synthetic `trace_runs` row, tagged `provider: 'operator'`, so the
 * intervention has something to hang off in the target's own timeline. That
 * row must not count as a message: `messagesToday` gates the per-owner daily
 * cap below, and without this filter, unblocking a visitor — restoring their
 * access — would silently spend one of their own messages doing it. A second
 * click (the operator's page is not guaranteed idempotent-proof) spends
 * another. "Restore this person's access" quietly taking it away is the
 * opposite of the intent.
 */
const IS_VISITOR_RUN = sql`${traceRuns.provider} <> 'operator'`

/** What every owner together has cost so far today, in USD. */
export async function spendToday(): Promise<number> {
  const [row] = await adminDb()
    .select({ total: sql<string>`coalesce(sum(${traceRuns.costUsdEst}), 0)` })
    .from(traceRuns)
    .where(and(gte(traceRuns.startedAt, UTC_DAY_START), IS_VISITOR_RUN))
  return Number(row?.total ?? 0)
}

/** How many turns this owner has started today. */
export async function messagesToday(owner: OwnerId): Promise<number> {
  const [row] = await adminDb()
    .select({ count: sql<string>`count(*)` })
    .from(traceRuns)
    .where(
      and(eq(traceRuns.ownerId, owner), gte(traceRuns.startedAt, UTC_DAY_START), IS_VISITOR_RUN),
    )
  // One row per turn, and a suspended turn resumes into the row it already has
  // rather than opening a second — so this counts turns, not halves of them.
  // Operator audit rows (see IS_VISITOR_RUN) are excluded for the same reason.
  return Number(row?.count ?? 0)
}

async function isBlocked(owner: OwnerId): Promise<boolean> {
  const [row] = await adminDb()
    .select({ blockedAt: user.blockedAt })
    .from(user)
    .where(eq(user.id, owner))
    .limit(1)
  return row?.blockedAt != null
}

/**
 * Decides whether a turn may run, and charges the address counter if it may.
 *
 * Check and charge are one call deliberately. Split in two, a caller that
 * forgets the second half has silently granted an unlimited per-address quota,
 * and nothing would fail. Charging only on the allow path matters too: an
 * exhausted visitor whose owner quota trips must not burn down the shared cap
 * for everyone else behind the same address.
 */
export async function consumeQuota(input: QuotaInput): Promise<QuotaVerdict> {
  const config = env()

  // Cheapest first, and these two are both the cheapest and the most absolute.
  if (await isLiveChatPaused()) return { allowed: false, reason: 'paused' }
  if (await isBlocked(input.owner)) return { allowed: false, reason: 'blocked' }

  const owner = await messagesToday(input.owner)

  if (input.kind === 'message') {
    const ownerCap = input.isAnonymous
      ? config.ANON_DAILY_MESSAGE_QUOTA
      : config.USER_DAILY_MESSAGE_QUOTA
    if (owner >= ownerCap) return { allowed: false, reason: 'owner_quota' }

    if (input.ipHash) {
      const used = await addressCount(input.ipHash)
      if (used >= config.IP_DAILY_MESSAGE_QUOTA) return { allowed: false, reason: 'ip_quota' }
    }
  }

  // Last, and independent of the other two: this is the layer that protects a
  // personal card, so it must not be reachable only through them.
  if ((await spendToday()) >= config.GLOBAL_DAILY_BUDGET_USD) {
    return { allowed: false, reason: 'daily_cap' }
  }

  const ip = input.kind === 'message' && input.ipHash ? await chargeAddress(input.ipHash) : 0
  return { allowed: true, used: { owner, ip } }
}

async function addressCount(key: string): Promise<number> {
  const [row] = await adminDb()
    .select({ count: rateLimits.count, windowStart: rateLimits.windowStart })
    .from(rateLimits)
    .where(eq(rateLimits.key, key))
    .limit(1)
  // The key already contains the date, so a stale window means a clock or salt
  // change rather than a rollover. Treating it as zero fails open by one day,
  // which is the right direction for a mistake in this layer.
  return row && row.windowStart === today() ? row.count : 0
}

/** Increments the counter for one address, returning its new total. */
async function chargeAddress(key: string): Promise<number> {
  const [row] = await adminDb()
    .insert(rateLimits)
    .values({ key, windowStart: today(), count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      // Increment in SQL rather than read-modify-write: two requests from one
      // address arriving together is the normal case, not the edge case.
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count })
  return row?.count ?? 0
}
