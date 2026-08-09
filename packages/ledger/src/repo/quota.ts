import { env } from '@kakeibo/core/env'
import { sha256 } from '@kakeibo/core/hash'
import { and, eq, gte, sql } from 'drizzle-orm'
import { user } from '../auth-schema'
import { adminDb } from '../db'
import type { OwnerId } from '../owner'
import { rateLimits, traceRuns } from '../schema'

/**
 * Cost control (spec §5).
 *
 * Four layers, cheapest first, all computed from tables that already exist:
 * `trace_runs` records owner and cost per turn, and `user` carries the blocked
 * flag. There are no rollup tables — at ~148 turns a day a direct scan stays
 * fast for years, and a rollup is a cache to invalidate for no present gain.
 *
 * Everything here runs on `adminDb`. The global cap is a sum across every
 * owner, which is exactly what the row-level security policies forbid, and the
 * blocked check reads `user`, which the application role has no privileges on
 * at all. This module is read-only apart from the address counter it increments
 * on the way through.
 */

export type QuotaReason = 'blocked' | 'owner_quota' | 'ip_quota' | 'daily_cap'

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

/** Today in the database's terms: a UTC date, matching `current_date`. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** What every owner together has cost so far today, in USD. */
export async function spendToday(): Promise<number> {
  const [row] = await adminDb()
    .select({ total: sql<string>`coalesce(sum(${traceRuns.costUsdEst}), 0)` })
    .from(traceRuns)
    .where(gte(traceRuns.startedAt, sql`current_date`))
  return Number(row?.total ?? 0)
}

/** How many turns this owner has started today. */
export async function messagesToday(owner: OwnerId): Promise<number> {
  const [row] = await adminDb()
    .select({ count: sql<string>`count(*)` })
    .from(traceRuns)
    .where(and(eq(traceRuns.ownerId, owner), gte(traceRuns.startedAt, sql`current_date`)))
  // One row per turn, and a suspended turn resumes into the row it already has
  // rather than opening a second — so this counts turns, not halves of them.
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

  // Cheapest first, and blocked is both the cheapest and the most absolute.
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
