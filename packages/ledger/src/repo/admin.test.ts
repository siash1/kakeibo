import { resetEnvCache } from '@kakeibo/core/env'
import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { user } from '../auth-schema'
import { adminDb, closeDb } from '../db'
import { asOwnerId, type OwnerId } from '../owner'
import { traceEvents, traceRuns } from '../schema'
import { resetOwners } from '../testing'
import {
  type AdminSession,
  adminGetRun,
  assertAdmin,
  blockOwner,
  budgetPanel,
  type HealthPanel,
  healthPanel,
  mapPanel,
  pauseLiveChat,
  recentRuns,
  safetyPanel,
  toolsPanel,
  trafficPanel,
  usersPanel,
} from './admin'
import { consumeQuota, messagesToday } from './quota'
import { getRun } from './tracer'

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

  it('excludes a run from the leaked pre-UTC-midnight band from "visitors today"', async () => {
    // Kolkata is UTC+5:30, so Kolkata midnight lands 5.5h before UTC midnight.
    // A bare `current_date` (session tz) casts back to that earlier instant,
    // so a run in the 5.5h band before UTC midnight reads as "today" under the
    // old bound and "yesterday" under the correct UTC-anchored one. This owner
    // has no other rows, so any leak shows up as a bump in `visitors.today`.
    const erin = asOwnerId('00000000-0000-4000-8000-0000000ad006')
    await resetOwners(erin)
    const before = await trafficPanel(session())
    await adminDb().insert(traceRuns).values({
      ownerId: erin,
      provider: 'test',
      model: 'test',
      channel: 'web',
      status: 'ok',
      startedAt: sql`(((now() at time zone 'utc')::date)::timestamp at time zone 'utc') - interval '2 hours'`,
    })
    const after = await trafficPanel(session())
    expect(after.visitors.today).toBe(before.visitors.today)
    await resetOwners(erin)
  })

  it('does not count an account created in the leaked band as predating today', async () => {
    // `user.created_at` is a naive `timestamp` (see auth-schema.ts), written as
    // the session-tz wall clock at insert time. A value of "today, 02:00" in
    // that naive column is *not* before Kolkata midnight (old bound: not
    // returning-eligible) but its real instant — 2026-08-08T20:30Z, reinterpreting
    // the naive value in the session's own tz — *is* before UTC midnight (new
    // bound: returning-eligible once they also have a run this week). The two
    // bounds disagree, which is exactly what pins the fix down.
    const frank = asOwnerId('00000000-0000-4000-8000-0000000ad007')
    await resetOwners(frank)
    const before = await trafficPanel(session())
    await adminDb()
      .update(user)
      .set({ createdAt: sql`current_date + interval '2 hours'` })
      .where(eq(user.id, frank))
    await runOn(frank, 0, 0.001)
    const after = await trafficPanel(session())
    // Isolated as a delta, not an absolute count: carol (this block's own
    // fixture) already satisfies "returning" on her own, so an absolute
    // assertion would pass even if frank's leaked-band account were wrongly
    // excluded.
    expect(after.returning - before.returning).toBe(1)
    await resetOwners(frank)
  })
})

/**
 * Writes a run and its events exactly as the loop would (see
 * `packages/core/src/loop.ts`): a `tool_call` success payload carries `name`,
 * `tier`, `args` and `result`; a handler failure swaps `result` for `error`
 * and drops `tier`; a `confirm` payload carries `id`, `tool`, `args` and
 * `allowed`, plus `suspended: true` on the pause half of a suspended write.
 */
async function auditedRun(
  owner: OwnerId,
  events: {
    type: 'confirm' | 'tool_call' | 'error' | 'model_call'
    payload: object
    latencyMs?: number
  }[],
): Promise<string> {
  const [run] = await adminDb()
    .insert(traceRuns)
    .values({
      ownerId: owner,
      provider: 'test',
      model: 'test',
      channel: 'web',
      status: 'ok',
      latencyMs: 1000,
    })
    .returning({ id: traceRuns.id })

  await adminDb()
    .insert(traceEvents)
    .values(
      events.map((event, seq) => ({
        ownerId: owner,
        runId: run!.id,
        seq,
        type: event.type,
        payload: event.payload,
        latencyMs: event.latencyMs ?? null,
      })),
    )
  return run!.id
}

describe('safetyPanel', () => {
  const audited = asOwnerId('00000000-0000-4000-8000-0000000ad003')

  beforeAll(async () => {
    await resetOwners(audited)
    // One suspended write that was allowed: two events, one decision.
    await auditedRun(audited, [
      {
        type: 'confirm',
        payload: { id: 'w1', tool: 'set_budget', allowed: null, suspended: true },
      },
      { type: 'confirm', payload: { id: 'w1', tool: 'set_budget', allowed: true } },
      {
        type: 'tool_call',
        payload: { name: 'set_budget', tier: 'write', args: {}, result: 'ok' },
        latencyMs: 12,
      },
    ])
    // One suspended write that was declined.
    await auditedRun(audited, [
      {
        type: 'confirm',
        payload: { id: 'w2', tool: 'set_budget', allowed: null, suspended: true },
      },
      { type: 'confirm', payload: { id: 'w2', tool: 'set_budget', allowed: false } },
    ])
    // One abandoned: the card was shown and nobody ever answered it.
    await auditedRun(audited, [
      {
        type: 'confirm',
        payload: { id: 'w3', tool: 'set_budget', allowed: null, suspended: true },
      },
    ])
    // One inline decision, which produces a single event.
    await auditedRun(audited, [
      { type: 'confirm', payload: { id: 'w4', tool: 'memory_save', allowed: true } },
      {
        type: 'tool_call',
        payload: { name: 'memory_save', tier: 'write', args: {}, result: 'ok' },
        latencyMs: 4,
      },
    ])
    // A processed upload, and a run the provider blocked outright.
    await auditedRun(audited, [
      {
        type: 'tool_call',
        payload: { name: 'import_statement_csv', tier: 'write', args: {}, result: 'ok' },
        latencyMs: 20,
      },
    ])
    await auditedRun(audited, [
      { type: 'error', payload: { kind: 'blocked', message: 'test block reason' } },
    ])
  }, 60_000)

  afterAll(async () => {
    await resetOwners(audited)
  })

  it('counts one decision per proposed write, not one per event', async () => {
    // A suspended write writes two confirm events - one when the turn pauses,
    // one when it is answered. Counting rows would double every one of them,
    // and the number on the dashboard would be wrong in the direction that
    // makes the guardrail look busier than it is.
    const panel = await safetyPanel(session())
    expect(panel.allowed).toBe(2)
    expect(panel.declined).toBe(1)
    expect(panel.awaiting).toBe(1)
    expect(panel.proposed).toBe(4)
  })

  it('counts processed uploads and surfaces blocked runs with their reason', async () => {
    const panel = await safetyPanel(session())
    expect(panel.imports).toBe(1)
    expect(panel.blockedRuns).toHaveLength(1)
    expect(panel.blockedRuns[0]?.reason).toBe('test block reason')
  })
})

describe('toolsPanel', () => {
  // Tool names unique to this suite: a real tool name like `set_budget` would
  // also pick up `tracer.test.ts`'s own uncleaned `tool_call` fixture (it
  // resets its owner's rows on the way in but never deletes the event it
  // writes), which is exactly the kind of cross-suite pollution that makes an
  // exact-count assertion flaky on a second run against the same database.
  const tooled = asOwnerId('00000000-0000-4000-8000-0000000ad010')

  beforeAll(async () => {
    await resetOwners(tooled)
    await auditedRun(tooled, [
      {
        type: 'tool_call',
        payload: { name: '__test_tool_a', tier: 'read', args: {}, result: 'ok' },
        latencyMs: 10,
      },
      {
        type: 'tool_call',
        payload: { name: '__test_tool_a', tier: 'read', args: {}, result: 'ok' },
        latencyMs: 20,
      },
      {
        type: 'tool_call',
        payload: { name: '__test_tool_a', args: {}, error: 'synthetic failure' },
        latencyMs: 30,
      },
      {
        type: 'tool_call',
        payload: { name: '__test_tool_b', tier: 'read', args: {}, result: 'ok' },
        latencyMs: 5,
      },
    ])
  }, 60_000)

  afterAll(async () => {
    await resetOwners(tooled)
  })

  it('reports calls, error rate and median latency per tool', async () => {
    const stats = await toolsPanel(session())
    const toolA = stats.find((stat) => stat.name === '__test_tool_a')
    expect(toolA?.calls).toBe(3)
    expect(toolA?.medianLatencyMs).toBe(20)
    expect(toolA?.errorPercent).toBeCloseTo(33.3, 1)

    const toolB = stats.find((stat) => stat.name === '__test_tool_b')
    expect(toolB?.calls).toBe(1)
    expect(toolB?.medianLatencyMs).toBe(5)
    expect(toolB?.errorPercent).toBe(0)
  })

  it('sorts by call count so the busiest tool is first', async () => {
    const stats = await toolsPanel(session())
    for (let i = 1; i < stats.length; i++) {
      expect(stats[i - 1]!.calls).toBeGreaterThanOrEqual(stats[i]!.calls)
    }
  })
})

describe('healthPanel', () => {
  const healthy = asOwnerId('00000000-0000-4000-8000-0000000ad011')

  async function statusRun(
    status: 'ok' | 'error' | 'blocked' | 'aborted',
    latencyMs: number,
  ): Promise<string> {
    const [run] = await adminDb()
      .insert(traceRuns)
      .values({
        ownerId: healthy,
        provider: 'test',
        model: 'test',
        channel: 'web',
        status,
        latencyMs,
      })
      .returning({ id: traceRuns.id })
    return run!.id
  }

  // Captured before the fixtures below are inserted, and used as a baseline
  // rather than an absolute figure for the same reason `budgetPanel`'s test
  // does: this panel aggregates every owner in the database, and other
  // suites' leftovers are already in "today" before this file ever runs.
  let before: HealthPanel

  beforeAll(async () => {
    await resetOwners(healthy)
    before = await healthPanel(session())

    await statusRun('ok', 100)
    await statusRun('ok', 200)
    await statusRun('ok', 300)
    await statusRun('ok', 400)
    await statusRun('error', 50)
    await statusRun('blocked', 50)
    const runId = await statusRun('aborted', 50)

    await adminDb()
      .insert(traceEvents)
      .values([
        {
          ownerId: healthy,
          runId,
          seq: 0,
          type: 'tool_call',
          payload: { name: '__test_tool_a', tier: 'read', args: {}, result: 'ok' },
          latencyMs: 5,
        },
        {
          ownerId: healthy,
          runId,
          seq: 1,
          type: 'tool_call',
          payload: { name: '__test_tool_a', args: {}, error: 'synthetic failure' },
          latencyMs: 5,
        },
        {
          ownerId: healthy,
          runId,
          seq: 2,
          type: 'error',
          payload: { kind: 'iteration_limit', iterations: 12 },
        },
      ])
  }, 60_000)

  afterAll(async () => {
    await resetOwners(healthy)
  })

  it('reports the status split and latency percentiles', async () => {
    const panel = await healthPanel(session())
    expect(panel.byStatus.ok - before.byStatus.ok).toBe(4)
    expect(panel.byStatus.error - before.byStatus.error).toBe(1)
    expect(panel.byStatus.blocked - before.byStatus.blocked).toBe(1)
    expect(panel.byStatus.aborted - before.byStatus.aborted).toBe(1)
    expect(panel.p95LatencyMs).toBeGreaterThanOrEqual(panel.p50LatencyMs)
  })

  it('counts iteration-limit hits and reports a tool error percent, not NaN', async () => {
    const panel = await healthPanel(session())
    expect(panel.iterationLimitHits - before.iterationLimitHits).toBe(1)
    // A percentage, and 0 rather than NaN when no tool has run at all.
    expect(panel.toolErrorPercent).toBeGreaterThanOrEqual(0)
  })
})

describe('recentRuns', () => {
  const runnerA = asOwnerId('00000000-0000-4000-8000-0000000ad020')
  const runnerB = asOwnerId('00000000-0000-4000-8000-0000000ad021')

  beforeAll(async () => {
    await resetOwners(runnerA, runnerB)
    await runOn(runnerA, 1, 0.01)
    await runOn(runnerB, 0, 0.02)
  }, 60_000)

  afterAll(async () => {
    await resetOwners(runnerA, runnerB)
  })

  it('shows who each run belonged to, which the scoped view cannot', async () => {
    const runs = await recentRuns(session(), 1000)
    const owners = new Set(runs.map((run) => run.ownerId))
    // Not just >1 in the abstract: both of this block's own owners must be
    // present, so the assertion does not depend on ambient rows some other
    // suite happened to leave behind.
    expect(owners.has(runnerA)).toBe(true)
    expect(owners.has(runnerB)).toBe(true)
    expect(runs[0]!.startedAt.getTime()).toBeGreaterThanOrEqual(runs.at(-1)!.startedAt.getTime())
  })

  it('resolves the owner through a join the scoped /runs view has no reason to do', async () => {
    const runs = await recentRuns(session(), 1000)
    const runB = runs.find((run) => run.ownerId === runnerB)
    expect(runB?.ownerEmail).toBe(`${runnerB}@kakeibo.local`)
    expect(runB?.ownerIsAnonymous).toBe(false)
    expect(runB?.costUsdEst).toBeCloseTo(0.02, 6)
  })
})

describe('adminGetRun', () => {
  const owner = asOwnerId('00000000-0000-4000-8000-0000000ad040')
  const stranger = asOwnerId('00000000-0000-4000-8000-0000000ad041')
  let runId: string

  beforeAll(async () => {
    await resetOwners(owner, stranger)
    runId = await auditedRun(owner, [
      {
        type: 'tool_call',
        payload: { name: 'list_accounts', tier: 'read', args: {}, result: 'ok' },
        latencyMs: 5,
      },
    ])
  }, 60_000)

  afterAll(async () => {
    await resetOwners(owner, stranger)
  })

  it('reads another owner’s run through the one door', async () => {
    // This is the drill-down every panel link on /admin points at — recentRuns
    // and safetyPanel.blockedRuns both link to /runs/[id] for a run that
    // essentially never belongs to the operator.
    const data = await adminGetRun(session(), runId)
    expect(data?.run.id).toBe(runId)
    expect(data?.run.ownerId).toBe(owner)
    expect(data?.events).toHaveLength(1)
    expect(data?.events[0]?.type).toBe('tool_call')
  })

  it('returns undefined for a run that does not exist, same as getRun', async () => {
    expect(await adminGetRun(session(), '00000000-0000-4000-8000-000000000000')).toBeUndefined()
  })

  it('the owner-scoped getRun still refuses a stranger — the fallback does not widen it', async () => {
    // adminGetRun exists precisely because getRun must stay owner-scoped; this
    // pins that getRun's own behaviour is untouched by adding the fallback.
    expect(await getRun(stranger, runId)).toBeUndefined()
    // The true owner can still read it the normal way.
    expect((await getRun(owner, runId))?.run.id).toBe(runId)
  })
})

describe('usersPanel', () => {
  const bob2 = asOwnerId('00000000-0000-4000-8000-0000000ad022')

  beforeAll(async () => {
    await resetOwners(alice, bob2)
    await runOn(alice, 0, 0.03)
    await runOn(alice, 0, 0.05)
  }, 60_000)

  afterAll(async () => {
    await resetOwners(alice, bob2)
  })

  it('attributes cost and today’s messages to each visitor', async () => {
    const users = await usersPanel(session(), 1000)
    const row = users.find((entry) => entry.id === alice)
    expect(row?.messagesToday).toBe(2)
    expect(row?.costUsdToDate).toBeCloseTo(0.08, 6)
    expect(row?.blockedAt).toBeNull()
  })

  it('shows a visitor who has never run a turn, with zeroes', async () => {
    // resetOwners creates the principal without any runs. Someone who signed
    // up and never spoke is exactly who you want to see on this panel.
    const users = await usersPanel(session(), 1000)
    const row = users.find((entry) => entry.id === bob2)
    expect(row?.messagesToday).toBe(0)
    expect(row?.costUsdToDate).toBe(0)
    expect(users.every((entry) => Number.isFinite(entry.costUsdToDate))).toBe(true)
  })

  it('sorts by last activity with never-active visitors last, not first', async () => {
    // NULLS FIRST is Postgres's default for `ORDER BY ... DESC`. Left alone,
    // every visitor who never ran a turn would sort ahead of every visitor who
    // did, and `limit` would cut the page off before it ever reached the
    // accounts that are actually spending money.
    const users = await usersPanel(session(), 1000)
    const aliceIndex = users.findIndex((entry) => entry.id === alice)
    const bobIndex = users.findIndex((entry) => entry.id === bob2)
    expect(aliceIndex).toBeGreaterThanOrEqual(0)
    expect(bobIndex).toBeGreaterThan(aliceIndex)
  })

  it('counts "today" from UTC midnight, not the session timezone', async () => {
    // Same leaked band as trafficPanel's regression test: a run 2 hours before
    // UTC midnight is still "today" under a bare `current_date` (Kolkata) but
    // is "yesterday" under the correct UTC-anchored bound.
    const before = await usersPanel(session(), 1000)
    const beforeCount = before.find((entry) => entry.id === alice)?.messagesToday ?? 0
    await adminDb().insert(traceRuns).values({
      ownerId: alice,
      provider: 'test',
      model: 'test',
      channel: 'web',
      status: 'ok',
      costUsdEst: '0.000001',
      startedAt: sql`(((now() at time zone 'utc')::date)::timestamp at time zone 'utc') - interval '2 hours'`,
    })
    const after = await usersPanel(session(), 1000)
    const afterCount = after.find((entry) => entry.id === alice)?.messagesToday ?? 0
    expect(afterCount).toBe(beforeCount)
  })
})

describe('mapPanel', () => {
  const mapped = asOwnerId('00000000-0000-4000-8000-0000000ad030')

  beforeAll(async () => {
    await resetOwners(mapped)
  })

  afterAll(async () => {
    await resetOwners(mapped)
  })

  it('groups located runs into points and drops unlocated ones', async () => {
    await adminDb()
      .insert(traceRuns)
      .values([
        {
          ownerId: mapped,
          provider: 'test',
          model: 'test',
          channel: 'web',
          geoCountry: 'IN',
          geoCity: 'Bengaluru',
          geoLat: 12.9716,
          geoLon: 77.5946,
        },
        {
          ownerId: mapped,
          provider: 'test',
          model: 'test',
          channel: 'web',
          geoCountry: 'IN',
          geoCity: 'Bengaluru',
          geoLat: 12.9716,
          geoLon: 77.5946,
        },
        // No location at all: local development, or an address the edge could
        // not resolve. It must not become a point at (0, 0) in the Gulf of
        // Guinea, which is where "default the coordinates" always lands.
        { ownerId: mapped, provider: 'test', model: 'test', channel: 'cli' },
      ])

    const points = await mapPanel(session())
    const bengaluru = points.find((point) => point.city === 'Bengaluru')
    expect(bengaluru?.runs).toBe(2)
    expect(points.every((point) => point.lat !== 0 || point.lon !== 0)).toBe(true)
  })
})

describe('operator actions', () => {
  afterEach(async () => {
    await pauseLiveChat(session(), false)
    await blockOwner(session(), bob, false)
  })

  afterAll(async () => {
    await closeDb()
  })

  it('pausing live chat degrades every visitor to the fallback', async () => {
    await pauseLiveChat(session(), true)
    expect(await consumeQuota({ owner: bob, isAnonymous: true, kind: 'message' })).toMatchObject({
      allowed: false,
      reason: 'paused',
    })
  })

  it('blocking an owner stops that owner and nobody else', async () => {
    await blockOwner(session(), bob, true)
    expect(await consumeQuota({ owner: bob, isAnonymous: true, kind: 'message' })).toMatchObject({
      allowed: false,
      reason: 'blocked',
    })
    expect((await consumeQuota({ owner: alice, isAnonymous: true, kind: 'message' })).allowed).toBe(
      true,
    )
  })

  it('records each intervention in the same timeline as everything else', async () => {
    await blockOwner(session(), bob, true)
    const events = await adminDb()
      .select({ payload: traceEvents.payload })
      .from(traceEvents)
      .where(sql`${traceEvents.payload}->>'kind' = 'operator_action'`)

    const blocked = events
      .map((event) => event.payload as { action?: string; target?: string; by?: string })
      .find((payload) => payload.action === 'block_owner' && payload.target === bob)

    // Who did it, to whom, and what changed. An audit entry that does not say
    // who is a note to nobody.
    expect(blocked?.by).toBe('operator@example.com')
  })

  it('does not cost the visitor a message off their daily cap to block and unblock them', async () => {
    // audit() writes a real trace_runs row for the target so the intervention
    // lands in their own timeline; messagesToday counts trace_runs rows for
    // that owner today with no other filter, and consumeQuota reads it to
    // enforce the per-owner cap. Unfiltered, restoring access would silently
    // spend one of the visitor's own messages doing it - the opposite of the
    // intent - and a repeated click would spend another.
    const before = await messagesToday(bob)
    await blockOwner(session(), bob, true)
    await blockOwner(session(), bob, false)
    expect(await messagesToday(bob)).toBe(before)
  })

  it('blocking an owner who no longer exists is a no-op, not a thrown error', async () => {
    // A reaped anonymous visitor: the operator's own page can still be
    // showing an id "user" no longer has. The update finds nothing to change,
    // and auditing it anyway would insert a trace_runs row against a foreign
    // key "user" cannot satisfy - throwing exactly where the update quietly
    // did not. The task-9 UI will be able to reach this with a stale id, so
    // it must not 500.
    const ghost = asOwnerId('00000000-0000-4000-8000-0000000ad099')
    await expect(blockOwner(session(), ghost, true)).resolves.toBeUndefined()
    const rows = await adminDb()
      .select({ id: traceRuns.id })
      .from(traceRuns)
      .where(eq(traceRuns.ownerId, ghost))
    expect(rows).toHaveLength(0)
  })
})
