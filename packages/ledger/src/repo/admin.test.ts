import { resetEnvCache } from '@kakeibo/core/env'
import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { user } from '../auth-schema'
import { adminDb, closeDb } from '../db'
import { asOwnerId, type OwnerId } from '../owner'
import { traceRuns } from '../schema'
import { resetOwners } from '../testing'
import { type AdminSession, assertAdmin, budgetPanel, trafficPanel } from './admin'

function allowlist(value: string): void {
  process.env.ADMIN_EMAILS = value
  resetEnvCache()
}

afterEach(() => {
  delete process.env.ADMIN_EMAILS
  resetEnvCache()
})

describe('assertAdmin', () => {
  it('admits an email on the allowlist', () => {
    allowlist('owner@example.com')
    expect(assertAdmin('owner@example.com')?.email).toBe('owner@example.com')
  })

  it('ignores case and surrounding whitespace on both sides', () => {
    allowlist('  Owner@Example.com , other@example.com ')
    expect(assertAdmin('owner@example.com')).toBeDefined()
    expect(assertAdmin(' OWNER@EXAMPLE.COM ')).toBeDefined()
  })

  it('refuses everyone when the allowlist is empty', () => {
    // The default. A missing environment variable must not be an open door.
    allowlist('')
    expect(assertAdmin('owner@example.com')).toBeUndefined()
  })

  it('refuses an absent email', () => {
    allowlist('owner@example.com')
    expect(assertAdmin(undefined)).toBeUndefined()
    expect(assertAdmin(null)).toBeUndefined()
    expect(assertAdmin('')).toBeUndefined()
  })

  it('refuses an email that merely contains an allowed one', () => {
    allowlist('owner@example.com')
    expect(assertAdmin('owner@example.com.attacker.test')).toBeUndefined()
    expect(assertAdmin('notowner@example.com')).toBeUndefined()
  })
})

/** An AdminSession for tests, built the only way one can be built. */
function session(): AdminSession {
  process.env.ADMIN_EMAILS = 'operator@example.com'
  resetEnvCache()
  const admin = assertAdmin('operator@example.com')
  if (!admin) throw new Error('the allowlist should have admitted this')
  return admin
}

const alice = asOwnerId('00000000-0000-4000-8000-0000000ad001')
const bob = asOwnerId('00000000-0000-4000-8000-0000000ad002')
const leaked = asOwnerId('00000000-0000-4000-8000-0000000ad005')

/** A finished run, backdated, so the day buckets can be tested at all. */
async function runOn(owner: OwnerId, daysAgo: number, costUsd: number): Promise<void> {
  await adminDb()
    .insert(traceRuns)
    .values({
      ownerId: owner,
      provider: 'test',
      model: 'test',
      channel: 'web',
      status: 'ok',
      costUsdEst: costUsd.toFixed(6),
      startedAt: sql`current_date - ${daysAgo} * interval '1 day' + interval '9 hours'`,
    })
}

describe('budgetPanel', () => {
  // Captured before the fixtures below are inserted, and used as a baseline
  // rather than an absolute figure: this database is shared serially by every
  // suite in the run (`fileParallelism: false`), and other suites' fixtures
  // — quota.test.ts's in particular — are not cleaned up after themselves, so
  // "today" already has cost in it before this file ever runs. A test that
  // asserted an absolute total would pass in isolation and fail the moment it
  // ran after them.
  let todayBefore = 0

  beforeAll(async () => {
    await resetOwners(alice, bob, leaked)
    todayBefore = (await budgetPanel(session())).todayUsd
    await runOn(alice, 0, 0.01)
    await runOn(alice, 0, 0.02)
    await runOn(alice, 3, 0.05)
    await runOn(bob, 0, 0.005)
  }, 60_000)

  afterAll(async () => {
    await resetOwners(alice, bob, leaked)
  })

  afterEach(() => {
    // Restored here rather than on the test's last line, so it comes back even
    // when an assertion above throws.
    delete process.env.GLOBAL_DAILY_BUDGET_USD
    resetEnvCache()
  })

  it('sums every owner, not just the operator', async () => {
    const panel = await budgetPanel(session())
    // 0.01 + 0.02 from Alice and 0.005 from Bob. A dashboard that showed only
    // the operator's own spend would report zero on a site with real traffic.
    expect(panel.todayUsd - todayBefore).toBeCloseTo(0.035, 6)
  })

  it('returns a 30-entry sparkline with quiet days at zero', async () => {
    const panel = await budgetPanel(session())
    expect(panel.sparkline).toHaveLength(30)
    // Oldest first, so it reads left to right like the chart it becomes.
    expect(panel.sparkline[0]!.day < panel.sparkline[29]!.day).toBe(true)
    expect(panel.sparkline.at(-1)!.usd - todayBefore).toBeCloseTo(0.035, 6)
    expect(panel.sparkline.every((point) => Number.isFinite(point.usd))).toBe(true)
  })

  it('projects the month at the current burn rate', async () => {
    const panel = await budgetPanel(session())
    // Month-to-date divided by elapsed days, times days in the month. Never
    // below month-to-date: a projection that undercuts what has already been
    // spent is worse than no projection.
    expect(panel.projectedMonthUsd).toBeGreaterThanOrEqual(panel.monthToDateUsd)
  })

  it('reports tripped once the day is over the cap', async () => {
    process.env.GLOBAL_DAILY_BUDGET_USD = '0.001'
    resetEnvCache()
    expect((await budgetPanel(session())).state).toBe('tripped')
  })

  it('excludes the last hour of the previous UTC month from month-to-date', async () => {
    // A bound built from `current_date` (or a bare UTC `::date` compared
    // against a `timestamptz` column) sits up to a session-timezone's worth of
    // hours before the true UTC month start. This row sits exactly in that
    // leaked window: real cost, wrong month.
    const before = await budgetPanel(session())
    await adminDb().insert(traceRuns).values({
      ownerId: leaked,
      provider: 'test',
      model: 'test',
      channel: 'web',
      status: 'ok',
      costUsdEst: '1.000000',
      startedAt: sql`(date_trunc('month', (now() at time zone 'utc'))::timestamp at time zone 'utc') - interval '1 hour'`,
    })
    const after = await budgetPanel(session())
    expect(after.monthToDateUsd).toBeCloseTo(before.monthToDateUsd, 6)
  })
})

describe('trafficPanel', () => {
  const carol = asOwnerId('00000000-0000-4000-8000-0000000ad003')
  const dave = asOwnerId('00000000-0000-4000-8000-0000000ad004')

  beforeAll(async () => {
    await resetOwners(carol, dave)
    // Backdated well before today, and marked anonymous, so the join-based
    // queries below have something unambiguous to find: a "returning" visitor
    // (active this week, account older than today) and an anonymous one.
    await adminDb()
      .update(user)
      .set({ createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) })
      .where(eq(user.id, carol))
    await adminDb().update(user).set({ isAnonymous: true }).where(eq(user.id, dave))
    await runOn(carol, 0, 0.001)
    await runOn(dave, 0, 0.001)
  }, 60_000)

  afterAll(async () => {
    await resetOwners(carol, dave)
    await closeDb()
  })

  it('counts visitors by kind and reports the conversion rate', async () => {
    const panel = await trafficPanel(session())
    expect(panel.visitors.today).toBeGreaterThanOrEqual(2)
    // Both figures come from the same distinct-owner, same-window query, split
    // by `user.isAnonymous` — so they agree by construction, not by luck of
    // what else happens to be in the "user" table.
    expect(panel.anonymous + panel.signedIn).toBe(panel.visitors.d30)
    // A percentage, not a fraction: 0..100, and 0 rather than NaN when there
    // is nobody at all.
    expect(panel.conversionPercent).toBeGreaterThanOrEqual(0)
    expect(panel.conversionPercent).toBeLessThanOrEqual(100)
  })

  it('counts a visitor whose account predates today as returning', async () => {
    const panel = await trafficPanel(session())
    expect(panel.returning).toBeGreaterThanOrEqual(1)
  })
})
