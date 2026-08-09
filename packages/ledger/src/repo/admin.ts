import { randomUUID } from 'node:crypto'
import { env } from '@kakeibo/core/env'
import { and, count, countDistinct, desc, eq, gte, isNotNull, sql } from 'drizzle-orm'
import { user } from '../auth-schema'
import { adminDb } from '../db'
import { traceEvents, traceRuns } from '../schema'
import { isLiveChatPaused, setFlag } from './flags'
// Type-only: `adminGetRun` below returns exactly what `getRun` returns, so its
// shape is derived rather than duplicated. `import type` erases this at
// runtime, so it does not give admin.ts a second way to reach a scoped read.
import type { getRun } from './tracer'

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
 * A trailing `DAYS`-day window is `DAYS - 1` days *before* `UTC_DAY_START`,
 * not `DAYS`: today is one of the days being counted, so subtracting the
 * full `DAYS` reaches back one day too far and turns "30 days" into 31 —
 * `UTC_DAY_START` itself plus 30 days before it. The sparkline below (which
 * this page's own aria-label calls "30-day spend") already builds its range
 * with `DAYS - 1`; `WINDOW` and the `d30` traffic figures did not, and this
 * repo's final whole-branch review is what caught the mismatch against the
 * "30 days" the page's labels and copy assert everywhere else.
 */

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

/**
 * True for a `trace_runs` row that is a visitor's own turn, false for the
 * synthetic row `audit()` (near the bottom of this file) writes for every
 * operator action.
 *
 * That synthetic row is real activity in `recentRuns` — the whole reason an
 * intervention lives in `trace_events` rather than a side log is that it
 * belongs in the same timeline as everything else, and the run list is that
 * timeline — but it is not a message anyone sent. Everywhere else a run is
 * counted, timed or costed as *visitor* activity, it has to be excluded, or
 * an operator's block/unblock click quietly counts against the very quota it
 * exists to override, drags a latency percentile down with a row that made
 * no model call, or shows up as usage on `usersPanel` — whose entire purpose
 * is making abuse visible, not moderation clicks.
 *
 * `provider: 'operator'` is the filter rather than `channel: 'mcp'` because a
 * real MCP turn also uses that channel; `provider` is `'gemini'` (see
 * `packages/core/src/gemini/adapter.ts`) for every turn that isn't this one.
 */
const IS_VISITOR_RUN = sql`${traceRuns.provider} <> 'operator'`

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
  //
  // IS_VISITOR_RUN here too, and for the same reason quota.ts's spendToday()
  // carries it: that function is what actually trips the global cap this
  // panel exists to display, and it excludes operator audit rows. Without the
  // same filter here, the two would read different row sets that only happen
  // to agree today because an audit row's cost is always zero — a coincidence
  // of the data, not a property of the code, that breaks the moment an audit
  // row ever carries a real cost. Task 7b existed because this panel and the
  // enforcer once disagreed about the *window*; this is the same defect
  // class, over the *rows*, caught before it shipped instead of after.
  const rows = await db
    .select({
      day: sql<string>`to_char(${traceRuns.startedAt} at time zone 'utc', 'YYYY-MM-DD')`,
      usd: sql<string>`coalesce(sum(${traceRuns.costUsdEst}), 0)`,
    })
    .from(traceRuns)
    .where(
      and(
        gte(traceRuns.startedAt, sql`${UTC_DAY_START} - ${DAYS - 1} * interval '1 day'`),
        IS_VISITOR_RUN,
      ),
    )
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

  // Same IS_VISITOR_RUN filter, same reason: month-to-date must agree with
  // spendToday() about which rows are spend, not just which window they fall
  // in.
  const [monthRow] = await db
    .select({ usd: sql<string>`coalesce(sum(${traceRuns.costUsdEst}), 0)` })
    .from(traceRuns)
    .where(and(gte(traceRuns.startedAt, UTC_MONTH_START), IS_VISITOR_RUN))

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

/**
 * Who is visiting (spec §9.5): counts, not identities — no IP or user agent
 * leaves `trace_runs`.
 *
 * All four bounds below are built from `UTC_DAY_START`, the same constant
 * `budgetPanel` and `WINDOW` use, rather than from a bare `current_date`. A
 * bare `current_date` casts back through the session's timezone
 * (`Asia/Kolkata` on this database) — left alone, "spend today" on the budget
 * panel and "visitors today" here would silently mean two different days.
 */
export async function trafficPanel(_session: AdminSession): Promise<TrafficPanel> {
  const db = unscoped()

  const active = async (days: number): Promise<number> => {
    const [row] = await db
      .select({ n: countDistinct(traceRuns.ownerId) })
      .from(traceRuns)
      .where(
        and(
          gte(traceRuns.startedAt, sql`${UTC_DAY_START} - ${days} * interval '1 day'`),
          IS_VISITOR_RUN,
        ),
      )
    return Number(row?.n ?? 0)
  }

  // Distinct owners active in the same 30-day window as `visitors.d30`, split
  // by kind, rather than a raw count of every row in "user". The two have to
  // agree by construction (`anonymous + signedIn === visitors.d30`): a signed-in
  // account that never came back would inflate a raw table count without ever
  // being a visitor, and the same window as `active(DAYS - 1)` is what keeps
  // the two numbers describing the same set of people — which is also why this
  // window has to move in lockstep with that call below rather than drift
  // independently. `IS_VISITOR_RUN` matters here for that same construction:
  // without it, an owner whose only row today is an operator's audit entry
  // would count on this side of the split but not in `active(DAYS - 1)`, and
  // the invariant would break.
  const [kinds] = await db
    .select({
      anonymous: sql<string>`count(distinct ${traceRuns.ownerId}) filter (where ${user.isAnonymous} is true)`,
      signedIn: sql<string>`count(distinct ${traceRuns.ownerId}) filter (where ${user.isAnonymous} is not true)`,
    })
    .from(traceRuns)
    .innerJoin(user, eq(user.id, traceRuns.ownerId))
    .where(
      and(
        gte(traceRuns.startedAt, sql`${UTC_DAY_START} - ${DAYS - 1} * interval '1 day'`),
        IS_VISITOR_RUN,
      ),
    )

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
        gte(traceRuns.startedAt, sql`${UTC_DAY_START} - 7 * interval '1 day'`),
        IS_VISITOR_RUN,
        // `user.created_at` is `timestamp` *without* time zone (see
        // auth-schema.ts), so it does not carry the instant it was written at —
        // it carries whatever `now()` looked like once cast into the session's
        // TimeZone at insert time (confirmed live: under Asia/Kolkata,
        // `now()::timestamp` reads back as the +05:30 wall clock, not UTC).
        // `UTC_DAY_START` is a `timestamptz`, so comparing it against the naive
        // column directly would silently re-apply the session's *current*
        // TimeZone to `user.created_at` on the way in — correct only if the
        // session timezone never changes between insert and query, which is not
        // a bet worth taking twice in the same file.
        //
        // Casting forward, `created_at::timestamptz`, reinterprets that naive
        // wall-clock value in the session's *current* TimeZone and recovers the
        // original instant — the exact inverse of the cast that stored it — but
        // only if the session zone at read time is the same one that was active
        // at insert time (verified: `(now()::timestamp)::timestamptz = now()`
        // holds within one session, not across a zone change between sessions).
        // Nothing in this codebase pins that; the real fix is to make
        // `user.created_at` a `timestamptz` in Better Auth's generated schema,
        // which is not this query's to do. Until then this is what belongs on
        // the left of a `timestamptz` comparison.
        sql`(${user.createdAt}::timestamptz) < ${UTC_DAY_START}`,
      ),
    )

  return {
    // DAYS - 1, not DAYS: see the comment on DAYS above. today's `active(0)`
    // needs no such adjustment — a single day's window is already "0 days
    // before today" — which is why it, and d7 (unflagged by the review that
    // caught this), are left as they were.
    visitors: { today: await active(0), d7: await active(7), d30: await active(DAYS - 1) },
    anonymous,
    signedIn,
    // A percentage, not a fraction, and 0 rather than NaN when there is nobody
    // at all — which is every site on day one.
    conversionPercent: total === 0 ? 0 : Math.round((signedIn / total) * 1000) / 10,
    returning: Number(returningRow?.n ?? 0),
  }
}

/**
 * The trailing window the health, safety and tools panels aggregate over —
 * a true `DAYS` (30) days, today included: see the comment on `DAYS` above
 * for why the subtraction is `DAYS - 1`, not `DAYS`.
 *
 * Built from `UTC_DAY_START`, not from a bare `current_date`: the latter casts
 * back through the session's timezone (`Asia/Kolkata` on this database) and
 * would silently shift the window by that offset, the same bug the sparkline
 * and month-to-date bounds above were fixed for.
 */
const WINDOW = sql`${UTC_DAY_START} - ${DAYS - 1} * interval '1 day'`

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
    // IS_VISITOR_RUN: an audit row's status is always 'ok' and its
    // latency_ms is always the column default, 0 — left in, it would count
    // as a fast, successful turn nobody actually had and drag the latency
    // percentiles toward zero.
    .where(and(gte(traceRuns.startedAt, WINDOW), IS_VISITOR_RUN))

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

export interface AdminRun {
  id: string
  startedAt: Date
  channel: string
  model: string
  status: string
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  costUsdEst: number
  latencyMs: number
  ownerId: string
  ownerEmail: string | null
  ownerIsAnonymous: boolean
}

/**
 * The existing `/runs` table (spec §9.3, item 6), unscoped and widened with an
 * owner column — which is the entire difference between a visitor's own view
 * and the operator's.
 *
 * Deliberately not filtered by `IS_VISITOR_RUN`, unlike every panel below
 * that counts, times or costs a run as visitor activity. The reason the audit
 * entry is a `trace_runs`/`trace_events` pair rather than a separate log is so
 * an intervention shows up in the same timeline as everything else, and this
 * is that timeline — filtering it out here would defeat the entire point of
 * `audit()`.
 */
export async function recentRuns(_session: AdminSession, limit = 100): Promise<AdminRun[]> {
  const rows = await unscoped()
    .select({
      id: traceRuns.id,
      startedAt: traceRuns.startedAt,
      channel: traceRuns.channel,
      model: traceRuns.model,
      status: traceRuns.status,
      inputTokens: traceRuns.inputTokens,
      cachedTokens: traceRuns.cachedTokens,
      outputTokens: traceRuns.outputTokens,
      costUsdEst: traceRuns.costUsdEst,
      latencyMs: traceRuns.latencyMs,
      ownerId: traceRuns.ownerId,
      ownerEmail: user.email,
      ownerIsAnonymous: user.isAnonymous,
    })
    .from(traceRuns)
    // Left join: the reaper deletes anonymous users, and their runs go with
    // them through the cascade — but a run whose owner vanished between the
    // reaper and this query should still appear here rather than dropping
    // out of the audit trail.
    .leftJoin(user, eq(user.id, traceRuns.ownerId))
    .orderBy(desc(traceRuns.startedAt))
    .limit(limit)

  return rows.map((row) => ({
    ...row,
    inputTokens: Number(row.inputTokens),
    cachedTokens: Number(row.cachedTokens),
    outputTokens: Number(row.outputTokens),
    costUsdEst: Number(row.costUsdEst),
    ownerEmail: row.ownerEmail ?? null,
    ownerIsAnonymous: row.ownerIsAnonymous === true,
  }))
}

/**
 * The operator's drill-down into another owner's run.
 *
 * Every cross-owner link on the dashboard — `recentRuns`, and
 * `safetyPanel.blockedRuns` — points at `/runs/[id]`, and that page's own
 * read, `getRun`, is owner-scoped: it returns undefined for anyone but the
 * run's own owner, which is exactly right for a visitor and exactly wrong for
 * the operator looking at someone else's row. This is the fallback the page
 * reaches for when the scoped read comes back empty and the caller has an
 * `AdminSession` — same shape as `getRun`, so the page renders either result
 * the same way without needing to know which function answered.
 */
export async function adminGetRun(
  _session: AdminSession,
  id: string,
): Promise<Awaited<ReturnType<typeof getRun>>> {
  const db = unscoped()
  const [run] = await db.select().from(traceRuns).where(eq(traceRuns.id, id)).limit(1)
  if (!run) return undefined
  const events = await db
    .select()
    .from(traceEvents)
    .where(eq(traceEvents.runId, id))
    .orderBy(traceEvents.seq)
  return {
    run: {
      ...run,
      inputTokens: Number(run.inputTokens),
      outputTokens: Number(run.outputTokens),
      cachedTokens: Number(run.cachedTokens),
      costUsdEst: Number(run.costUsdEst),
    },
    events: events.map((event) => ({
      ...event,
      inputTokens: event.inputTokens === null ? null : Number(event.inputTokens),
      outputTokens: event.outputTokens === null ? null : Number(event.outputTokens),
      cachedTokens: event.cachedTokens === null ? null : Number(event.cachedTokens),
    })),
  }
}

export interface AdminUser {
  id: string
  email: string
  isAnonymous: boolean
  createdAt: Date
  lastSeenAt: Date | null
  messagesToday: number
  costUsdToDate: number
  blockedAt: Date | null
}

/**
 * Who is using the site and what they are costing (spec §9.3, item 7). Cost
 * per user is the reason this panel exists at all rather than being a list of
 * email addresses — it is how abuse becomes visible.
 *
 * One left join and one group, rather than a query per user. `messagesToday`
 * is bounded by `UTC_DAY_START` for the same reason `trafficPanel` was: a
 * bare `current_date` would report "today" in the session's timezone while
 * every other panel on this dashboard means the UTC day.
 *
 * `IS_VISITOR_RUN` sits in the join condition rather than in each aggregate,
 * so a visitor whose only `trace_runs` rows today are operator audit entries
 * joins to nothing — exactly as if they had not been active — for every
 * column at once: `messagesToday`, `costUsdToDate` (already zero for an audit
 * row, but this is where that stops being an accident) and `lastSeenAt`.
 * `lastSeenAt` matters here as much as the message count: this panel's whole
 * job is making abuse visible, and a dormant visitor should not look freshly
 * active because an operator clicked "block" on them.
 */
export async function usersPanel(_session: AdminSession, limit = 200): Promise<AdminUser[]> {
  const rows = await unscoped()
    .select({
      id: user.id,
      email: user.email,
      isAnonymous: user.isAnonymous,
      createdAt: user.createdAt,
      blockedAt: user.blockedAt,
      lastSeenAt: sql<Date | null>`max(${traceRuns.startedAt})`,
      messagesToday: sql<string>`count(${traceRuns.id}) filter (where ${traceRuns.startedAt} >= ${UTC_DAY_START})`,
      costUsdToDate: sql<string>`coalesce(sum(${traceRuns.costUsdEst}), 0)`,
    })
    .from(user)
    .leftJoin(traceRuns, and(eq(traceRuns.ownerId, user.id), IS_VISITOR_RUN))
    .groupBy(user.id)
    // Busiest (most recently active) first. NULLS LAST is not the default for
    // DESC in Postgres — without it, visitors who never ran a turn (whose
    // `max(started_at)` is null) would sort to the very top, ahead of anyone
    // who has actually spent money, and `limit` would cut off the page before
    // ever reaching the accounts this panel exists to surface.
    .orderBy(sql`max(${traceRuns.startedAt}) desc nulls last`)
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    isAnonymous: row.isAnonymous === true,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    messagesToday: Number(row.messagesToday),
    costUsdToDate: Number(row.costUsdToDate),
    blockedAt: row.blockedAt,
  }))
}

export interface MapPoint {
  country: string | null
  region: string | null
  city: string | null
  lat: number
  lon: number
  runs: number
}

/**
 * Approximate visitor locations, sized by activity (spec §9.3 item 8, §9.5).
 *
 * Returns only located runs. A run with no coordinates is not a point at
 * (0, 0) — that is open ocean off West Africa, and a map that puts every
 * local development turn there is worse than one that omits them. Windowed
 * to the same trailing 30 days as the health, safety and tools panels: the
 * map shows current activity, not a permanent location history.
 */
export async function mapPanel(_session: AdminSession): Promise<MapPoint[]> {
  const rows = await unscoped()
    .select({
      country: traceRuns.geoCountry,
      region: traceRuns.geoRegion,
      city: traceRuns.geoCity,
      lat: traceRuns.geoLat,
      lon: traceRuns.geoLon,
      runs: count(),
    })
    .from(traceRuns)
    .where(
      and(
        isNotNull(traceRuns.geoLat),
        isNotNull(traceRuns.geoLon),
        gte(traceRuns.startedAt, WINDOW),
      ),
    )
    .groupBy(
      traceRuns.geoCountry,
      traceRuns.geoRegion,
      traceRuns.geoCity,
      traceRuns.geoLat,
      traceRuns.geoLon,
    )
    .orderBy(desc(count()))

  return rows.map((row) => ({
    country: row.country,
    region: row.region,
    city: row.city,
    lat: Number(row.lat),
    lon: Number(row.lon),
    runs: Number(row.runs),
  }))
}

/**
 * An operator intervention, recorded where every other event is recorded.
 *
 * It needs a run to hang off, so it makes one: a zero-cost `trace_runs` row on
 * the mcp channel owned by the target, which puts the intervention in that
 * visitor's own timeline where anyone investigating them will see it.
 *
 * `type` is 'error' because the enum has no better member, and adding one
 * would be a migration for a label. Queries match on payload kind — in
 * particular `kind: 'operator_action'` here is distinct from `'blocked'`
 * (safetyPanel's blocked-run query) and `'iteration_limit'` (healthPanel's
 * count above), so an audit row never gets picked up by either.
 */
async function audit(
  session: AdminSession,
  target: string,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const db = unscoped()
  const runId = randomUUID()
  await db.insert(traceRuns).values({
    id: runId,
    ownerId: target,
    provider: 'operator',
    model: 'none',
    channel: 'mcp',
    status: 'ok',
  })
  await db.insert(traceEvents).values({
    ownerId: target,
    runId,
    seq: 0,
    type: 'error',
    payload: { kind: 'operator_action', action, target, by: session.email, ...detail },
  })
}

/**
 * The manual kill switch (spec §9.4).
 *
 * Independent of the budget trip on purpose: the reason to reach for this is
 * usually not cost, and waiting for a cap to catch up is not an incident
 * response. Visitors get the same graceful fallback as a quota trip.
 */
export async function blockOwner(
  session: AdminSession,
  ownerId: string,
  blocked: boolean,
): Promise<void> {
  const updated = await unscoped()
    .update(user)
    .set({ blockedAt: blocked ? new Date() : null })
    .where(eq(user.id, ownerId))
    .returning({ id: user.id })
  // A stale id — the operator's own page can still be showing a visitor the
  // nightly reaper has since deleted — makes the update above a silent no-op.
  // Auditing it anyway would insert a trace_runs row owned by an id "user" no
  // longer has, and trace_runs.owner_id references "user" — the foreign key
  // would throw exactly where the update quietly did not. Nothing happened,
  // so there is nothing to audit.
  if (updated.length === 0) return
  await audit(session, ownerId, 'block_owner', { blocked })
}

/**
 * The site-wide live-chat kill switch (spec §9.4).
 *
 * A site-wide action has no natural owner, and `trace_runs.owner_id`
 * references `"user"(id)` — so the audit entry is attributed to the
 * operator's own row via `adminOwnerId`.
 */
export async function pauseLiveChat(session: AdminSession, paused: boolean): Promise<void> {
  await setFlag('live_chat_paused', paused)
  const owner = await adminOwnerId(session)
  // If the operator has no account row yet, the switch still flips and only
  // the audit entry is skipped. Losing an audit line is better than refusing
  // to pause during an incident.
  if (owner) await audit(session, owner, 'pause_live_chat', { paused })
}
