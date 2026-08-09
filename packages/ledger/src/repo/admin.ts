import { env } from '@kakeibo/core/env'
import { and, countDistinct, eq, gte, sql } from 'drizzle-orm'
import { user } from '../auth-schema'
import { adminDb } from '../db'
import { traceEvents, traceRuns } from '../schema'
import { isLiveChatPaused } from './flags'

/**
 * The operator dashboard (spec §9).
 *
 * **This module is the only place in the application permitted to read across
 * owners.** Row-level security (Plan A §4.2) exists to make a forgotten
 * `where owner_id = ...` return nothing instead of another visitor's ledger;
 * every function here deliberately steps around that, because a dashboard that
 * could only see its own operator's data would show nothing.
 *
 * Two rules keep that safe, and a reviewer should be able to check both by
 * reading this one file:
 *
 *  1. Every exported function takes an `AdminSession` as its first parameter.
 *     That value cannot be constructed outside `assertAdmin`, so a caller
 *     cannot reach these reads without having proved who they are first. The
 *     functions do not re-check authorization themselves — one check, at one
 *     door, is easier to audit than eleven scattered ones.
 *  2. Every function is read-only except the two operator actions, which are
 *     individually named and write an audit event.
 *
 * `packages/ledger/src/admin-containment.test.ts` asserts that the set of
 * modules holding the RLS-bypassing connection is the reviewed one.
 */

/**
 * Proof that the caller is the operator.
 *
 * A branded type with a private symbol: nothing produces one by accident, the
 * way `{ email }` passed where an `AdminSession` was expected would if the
 * type were a bare `{ email: string }`. A deliberate `{ email } as
 * AdminSession` still compiles — a single `as` cast is allowed in either
 * direction between structurally related types, and importing the private
 * symbol does not change that — so the brand stops a mistake at the call
 * site, which is the only place it is cheap to catch, not someone willing to
 * write the cast. That bar is the right one: anyone able to write `as
 * AdminSession` in this codebase can already call `adminDb()` directly, so
 * there is nothing further here for the brand to defend.
 */
declare const verified: unique symbol
export interface AdminSession {
  readonly email: string
  readonly [verified]: true
}

/**
 * Turns an authenticated email into an AdminSession, or undefined.
 *
 * The allowlist is an env var rather than a roles table because there is
 * exactly one operator, and a table would be ceremony around a constant.
 * Comparison is case-insensitive and trimmed: an allowlist that fails because
 * someone typed a trailing space is an allowlist that gets disabled.
 */
export function assertAdmin(email: string | undefined | null): AdminSession | undefined {
  if (!email) return undefined
  const allowed = env()
    .ADMIN_EMAILS.split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  if (allowed.length === 0) return undefined
  if (!allowed.includes(email.trim().toLowerCase())) return undefined
  return { email } as AdminSession
}

/** Every read below goes through this, so the bypass is one expression. */
function unscoped() {
  return adminDb()
}

/**
 * The operator's own `user.id`, or undefined if they have never signed in here.
 *
 * Belongs with authorization rather than with the panels: it is the second half
 * of turning a verified session into something the database can talk about. The
 * audit trail in the operator actions needs it, because `trace_runs.owner_id`
 * references `"user"(id)` and a site-wide action has no visitor to attribute to.
 */
export async function adminOwnerId(session: AdminSession): Promise<string | undefined> {
  const [row] = await unscoped()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, session.email))
    .limit(1)
  return row?.id
}

const DAYS = 30

/**
 * Midnight at the start of today, UTC — as a `timestamptz` *instant*, not a
 * `date`.
 *
 * The database's session timezone is not guaranteed to be UTC — it is
 * whatever the Postgres server was initialised with, which on at least one
 * developer machine is the host's local zone, not UTC. `sparkline` below
 * builds its day keys with `Date.prototype.toISOString`, which is always UTC;
 * bucketing rows with a bare `current_date` would silently misfile the last
 * few hours of the UTC day into the wrong bucket, or off the end of the
 * sparkline entirely, whenever the two clocks disagree about what day it is.
 *
 * A `date` is not enough on its own: comparing it against the `timestamptz`
 * column `trace_runs.started_at` forces an implicit cast back to
 * `timestamptz`, and that cast applies the *session* timezone again — so
 * `(now() at time zone 'utc')::date` alone still produces a bound that sits
 * off by the session's UTC offset. Converting through a naive `timestamp`
 * and back with an explicit `at time zone 'utc'` fixes the instant in place
 * regardless of the session's configured zone.
 */
const UTC_DAY_START = sql`(((now() at time zone 'utc')::date)::timestamp at time zone 'utc')`

/** The start of the current UTC month, as the same kind of pinned instant. */
const UTC_MONTH_START = sql`(date_trunc('month', (now() at time zone 'utc'))::timestamp at time zone 'utc')`

export interface BudgetPanel {
  todayUsd: number
  monthToDateUsd: number
  projectedMonthUsd: number
  dailyCapUsd: number
  monthlyCeilingUsd: number
  state: 'ok' | 'tripped' | 'paused'
  sparkline: { day: string; usd: number }[]
}

export interface TrafficPanel {
  visitors: { today: number; d7: number; d30: number }
  anonymous: number
  signedIn: number
  conversionPercent: number
  returning: number
}

/**
 * What the site is costing (spec §9.3), first and largest of the panels: the
 * $20/month ceiling is on a personal card, and a surprise there is a surprise
 * on a bill.
 */
export async function budgetPanel(_session: AdminSession): Promise<BudgetPanel> {
  const config = env()
  const db = unscoped()

  // One scan, bucketed by day, rather than thirty queries. At ~148 turns a day
  // this stays fast for years, which is why §9.3 rules out rollup tables.
  const rows = await db
    .select({
      day: sql<string>`to_char(${traceRuns.startedAt} at time zone 'utc', 'YYYY-MM-DD')`,
      usd: sql<string>`coalesce(sum(${traceRuns.costUsdEst}), 0)`,
    })
    .from(traceRuns)
    .where(gte(traceRuns.startedAt, sql`${UTC_DAY_START} - ${DAYS - 1} * interval '1 day'`))
    .groupBy(sql`1`)

  const byDay = new Map(rows.map((row) => [row.day, Number(row.usd)]))

  // Filled, not sparse: a series that skips quiet days compresses the x-axis
  // and makes a flat month look like steady traffic.
  const today = new Date()
  const sparkline: { day: string; usd: number }[] = []
  for (let back = DAYS - 1; back >= 0; back--) {
    const date = new Date(today)
    date.setUTCDate(date.getUTCDate() - back)
    const day = date.toISOString().slice(0, 10)
    sparkline.push({ day, usd: byDay.get(day) ?? 0 })
  }

  const [monthRow] = await db
    .select({ usd: sql<string>`coalesce(sum(${traceRuns.costUsdEst}), 0)` })
    .from(traceRuns)
    .where(gte(traceRuns.startedAt, UTC_MONTH_START))

  const todayUsd = sparkline.at(-1)?.usd ?? 0
  const monthToDateUsd = Number(monthRow?.usd ?? 0)

  const dayOfMonth = today.getUTCDate()
  const daysInMonth = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0),
  ).getUTCDate()
  // Never below month-to-date: a projection that undercuts money already spent
  // is worse than no projection at all.
  const projectedMonthUsd = Math.max(monthToDateUsd, (monthToDateUsd / dayOfMonth) * daysInMonth)

  return {
    todayUsd,
    monthToDateUsd,
    projectedMonthUsd,
    dailyCapUsd: config.GLOBAL_DAILY_BUDGET_USD,
    monthlyCeilingUsd: config.GLOBAL_DAILY_BUDGET_USD * daysInMonth,
    state: (await isLiveChatPaused())
      ? 'paused'
      : todayUsd >= config.GLOBAL_DAILY_BUDGET_USD
        ? 'tripped'
        : 'ok',
    sparkline,
  }
}

/** Who is visiting (spec §9.5): counts, not identities — no IP or user agent leaves `trace_runs`. */
export async function trafficPanel(_session: AdminSession): Promise<TrafficPanel> {
  const db = unscoped()

  const active = async (days: number): Promise<number> => {
    const [row] = await db
      .select({ n: countDistinct(traceRuns.ownerId) })
      .from(traceRuns)
      .where(gte(traceRuns.startedAt, sql`current_date - ${days} * interval '1 day'`))
    return Number(row?.n ?? 0)
  }

  // Distinct owners active in the same 30-day window as `visitors.d30`, split
  // by kind, rather than a raw count of every row in "user". The two have to
  // agree by construction (`anonymous + signedIn === visitors.d30`): a signed-in
  // account that never came back would inflate a raw table count without ever
  // being a visitor, and the same window as `active(DAYS)` is what keeps the
  // two numbers describing the same set of people.
  const [kinds] = await db
    .select({
      anonymous: sql<string>`count(distinct ${traceRuns.ownerId}) filter (where ${user.isAnonymous} is true)`,
      signedIn: sql<string>`count(distinct ${traceRuns.ownerId}) filter (where ${user.isAnonymous} is not true)`,
    })
    .from(traceRuns)
    .innerJoin(user, eq(user.id, traceRuns.ownerId))
    .where(gte(traceRuns.startedAt, sql`current_date - ${DAYS} * interval '1 day'`))

  const anonymous = Number(kinds?.anonymous ?? 0)
  const signedIn = Number(kinds?.signedIn ?? 0)
  const total = anonymous + signedIn

  // Distinct owners with a run in the last week whose account predates today:
  // "active, and was not first seen today." Joined against `user` rather than
  // counting rows in `user` directly for the same reason as above — the reaper
  // deletes anonymous visitors after 24 hours (cascading away their runs with
  // them), so a row that still exists in `trace_runs` always has a live owner
  // to join against.
  const [returningRow] = await db
    .select({ n: countDistinct(traceRuns.ownerId) })
    .from(traceRuns)
    .innerJoin(user, eq(user.id, traceRuns.ownerId))
    .where(
      and(
        gte(traceRuns.startedAt, sql`current_date - 7 * interval '1 day'`),
        sql`${user.createdAt} < current_date`,
      ),
    )

  return {
    visitors: { today: await active(0), d7: await active(7), d30: await active(DAYS) },
    anonymous,
    signedIn,
    // A percentage, not a fraction, and 0 rather than NaN when there is nobody
    // at all — which is every site on day one.
    conversionPercent: total === 0 ? 0 : Math.round((signedIn / total) * 1000) / 10,
    returning: Number(returningRow?.n ?? 0),
  }
}

/**
 * The trailing window the health, safety and tools panels aggregate over.
 *
 * Built from `UTC_DAY_START`, not from a bare `current_date`: the latter casts
 * back through the session's timezone (`Asia/Kolkata` on this database) and
 * would silently shift the window by that offset, the same bug the sparkline
 * and month-to-date bounds above were fixed for.
 */
const WINDOW = sql`${UTC_DAY_START} - ${DAYS} * interval '1 day'`

export interface HealthPanel {
  byStatus: { ok: number; error: number; blocked: number; aborted: number }
  p50LatencyMs: number
  p95LatencyMs: number
  iterationLimitHits: number
  toolErrorPercent: number
}

export interface SafetyPanel {
  proposed: number
  allowed: number
  declined: number
  awaiting: number
  imports: number
  blockedRuns: { runId: string; reason: string }[]
}

export interface ToolStat {
  name: string
  calls: number
  errorPercent: number
  medianLatencyMs: number
}

/** Is the site working (spec §9.3, item 3): run outcomes and how long they take. */
export async function healthPanel(_session: AdminSession): Promise<HealthPanel> {
  const db = unscoped()

  const [row] = await db
    .select({
      ok: sql<string>`count(*) filter (where ${traceRuns.status} = 'ok')`,
      error: sql<string>`count(*) filter (where ${traceRuns.status} = 'error')`,
      blocked: sql<string>`count(*) filter (where ${traceRuns.status} = 'blocked')`,
      aborted: sql<string>`count(*) filter (where ${traceRuns.status} = 'aborted')`,
      // percentile_cont over latency_ms, which is exact rather than sampled —
      // at this volume there is no reason to approximate.
      p50: sql<string>`coalesce(percentile_cont(0.5) within group (order by ${traceRuns.latencyMs}), 0)`,
      p95: sql<string>`coalesce(percentile_cont(0.95) within group (order by ${traceRuns.latencyMs}), 0)`,
    })
    .from(traceRuns)
    .where(gte(traceRuns.startedAt, WINDOW))

  const [tools] = await db
    .select({
      calls: sql<string>`count(*) filter (where ${traceEvents.type} = 'tool_call')`,
      errors: sql<string>`count(*) filter (where ${traceEvents.type} = 'tool_call' and ${traceEvents.payload} ? 'error')`,
      iterationLimits: sql<string>`count(*) filter (where ${traceEvents.type} = 'error' and ${traceEvents.payload}->>'kind' = 'iteration_limit')`,
    })
    .from(traceEvents)
    .innerJoin(traceRuns, eq(traceRuns.id, traceEvents.runId))
    .where(gte(traceRuns.startedAt, WINDOW))

  const calls = Number(tools?.calls ?? 0)
  const errors = Number(tools?.errors ?? 0)

  return {
    byStatus: {
      ok: Number(row?.ok ?? 0),
      error: Number(row?.error ?? 0),
      blocked: Number(row?.blocked ?? 0),
      aborted: Number(row?.aborted ?? 0),
    },
    p50LatencyMs: Math.round(Number(row?.p50 ?? 0)),
    p95LatencyMs: Math.round(Number(row?.p95 ?? 0)),
    iterationLimitHits: Number(tools?.iterationLimits ?? 0),
    // A percentage, and 0 rather than NaN when no tool has run at all.
    toolErrorPercent: calls === 0 ? 0 : Math.round((errors / calls) * 1000) / 10,
  }
}

/**
 * Is the write-confirmation guardrail doing its job (spec §9.3, item 4).
 *
 * The panel counts *decisions*, not rows. A write under the `suspend` policy
 * writes two `confirm` events — one at suspension with `allowed: null` and
 * `suspended: true`, one at resume with `allowed` set — while `inline` and
 * `auto-*` writes produce one, already decided. Counting rows naively would
 * double every suspended write and report the guardrail as busier than it is.
 * `allowed` and `declined` come straight from the decided events; `awaiting`
 * is a suspension event with no answered sibling sharing `(run_id,
 * payload->>'id')` — a confirmation card nobody ever ruled on.
 */
export async function safetyPanel(_session: AdminSession): Promise<SafetyPanel> {
  const db = unscoped()

  const [decisions] = await db
    .select({
      allowed: sql<string>`count(*) filter (where ${traceEvents.payload}->>'allowed' = 'true')`,
      declined: sql<string>`count(*) filter (where ${traceEvents.payload}->>'allowed' = 'false')`,
      awaiting: sql<string>`count(*) filter (
        where ${traceEvents.payload}->>'suspended' = 'true'
          and not exists (
            select 1 from trace_events answered
            where answered.run_id = ${traceEvents.runId}
              and answered.payload->>'id' = ${traceEvents.payload}->>'id'
              and answered.payload->>'allowed' is not null
          )
      )`,
    })
    .from(traceEvents)
    .innerJoin(traceRuns, eq(traceRuns.id, traceEvents.runId))
    .where(and(eq(traceEvents.type, 'confirm'), gte(traceRuns.startedAt, WINDOW)))

  const [imports] = await db
    .select({ n: sql<string>`count(*)` })
    .from(traceEvents)
    .innerJoin(traceRuns, eq(traceRuns.id, traceEvents.runId))
    .where(
      and(
        eq(traceEvents.type, 'tool_call'),
        sql`${traceEvents.payload}->>'name' = 'import_statement_csv'`,
        gte(traceRuns.startedAt, WINDOW),
      ),
    )

  const blockedRuns = await db
    .select({
      runId: traceEvents.runId,
      reason: sql<string>`coalesce(${traceEvents.payload}->>'message', 'no reason recorded')`,
    })
    .from(traceEvents)
    .innerJoin(traceRuns, eq(traceRuns.id, traceEvents.runId))
    .where(
      and(
        eq(traceEvents.type, 'error'),
        sql`${traceEvents.payload}->>'kind' = 'blocked'`,
        gte(traceRuns.startedAt, WINDOW),
      ),
    )
    .limit(20)

  const allowed = Number(decisions?.allowed ?? 0)
  const declined = Number(decisions?.declined ?? 0)
  const awaiting = Number(decisions?.awaiting ?? 0)

  return {
    proposed: allowed + declined + awaiting,
    allowed,
    declined,
    awaiting,
    imports: Number(imports?.n ?? 0),
    blockedRuns,
  }
}

/** Which tools are actually earning selection (spec §9.3, item 5). */
export async function toolsPanel(_session: AdminSession): Promise<ToolStat[]> {
  const db = unscoped()

  const rows = await db
    .select({
      name: sql<string>`${traceEvents.payload}->>'name'`,
      calls: sql<string>`count(*)`,
      errors: sql<string>`count(*) filter (where ${traceEvents.payload} ? 'error')`,
      median: sql<string>`coalesce(percentile_cont(0.5) within group (order by ${traceEvents.latencyMs}), 0)`,
    })
    .from(traceEvents)
    .innerJoin(traceRuns, eq(traceRuns.id, traceEvents.runId))
    .where(
      and(
        eq(traceEvents.type, 'tool_call'),
        sql`${traceEvents.payload}->>'name' is not null`,
        gte(traceRuns.startedAt, WINDOW),
      ),
    )
    .groupBy(sql`1`)

  return (
    rows
      .map((row) => {
        const calls = Number(row.calls)
        return {
          name: row.name,
          calls,
          errorPercent: calls === 0 ? 0 : Math.round((Number(row.errors) / calls) * 1000) / 10,
          medianLatencyMs: Math.round(Number(row.median)),
        }
      })
      // Busiest first: this panel exists to show which tool descriptions are
      // earning selection and which are not.
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
  )
}
