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
  assertAdmin,
  budgetPanel,
  type HealthPanel,
  healthPanel,
  safetyPanel,
  toolsPanel,
  trafficPanel,
} from './admin'

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
    await closeDb()
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
