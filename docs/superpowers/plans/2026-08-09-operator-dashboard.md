# Operator Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the owner one page that shows what the deployed app is doing and costing, and two buttons that can stop it — without weakening the tenant isolation that everything else rests on.

**Architecture:** One module, `packages/ledger/src/repo/admin.ts`, is the only place in the application that reads across owners. Every panel is a function in it, every function takes an already-verified `AdminSession`, and a containment test asserts nothing else acquired the same reach. The data all exists already — `trace_runs`, `trace_events` and the Better Auth `user` table — so no new instrumentation is needed beyond five nullable geolocation columns and a two-row flags table.

**Tech Stack:** Next.js 15 App Router (server components), Drizzle ORM, PostgreSQL, TypeScript strict, Vitest.

This is **Plan C of four**. Plan A (merged) made every ledger row owner-scoped with an RLS backstop. Plan B (merged) added auth, the suspendable loop, quotas and persistence. **Plan D** — the public surface and the deploy — is deliberately split out; see "Why this plan stops where it does" at the end.

## Global Constraints

Copied verbatim from `CLAUDE.md`; every task's requirements include these.

- **No AI co-author trailers in commits.** No `Co-Authored-By: Claude`, no "Generated with" footers. Author is the repository owner.
- **TypeScript strict everywhere.** `any` only at the provider wire boundary, with a comment.
- **Money is integer minor units** (paise). Never floats outside display. *(USD costs are the documented exception: `cost_usd_est` is `numeric(10,6)` and read as a number, because it is a provider price estimate rather than ledger money.)*
- **Secrets never in git.** `.env` is gitignored; `.env.example` carries empty values only.
- **No agent frameworks in core.** `@google/genai` is a typed HTTP client only.
- **Every ledger query is owner-scoped**, and new repository reads go into `packages/ledger/src/isolation.test.ts`. The functions in `admin.ts` are the one exception in the codebase, which is exactly why Task 4 exists.
- **The isolation suite runs twice**; never fix a failure in the RLS-bypassed pass by adjusting the assertion.
- Better Auth's principal table is `user`, a reserved word: **always quote it** as `"user"` in hand-written SQL.
- `pnpm lint && pnpm typecheck && pnpm test` must pass before every commit.
- **Every number the README claims must be reproducible by a script in this repo.** Nothing in this plan adds a README number; if a task tempts you to, add it to `pnpm metrics` first.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/ledger/src/schema.ts` | **Modify.** Five `geo_*` columns on `trace_runs`; new `operator_flags` table. |
| `packages/core/src/trace.ts` | **Modify.** `startRun` accepts an optional provider-neutral `geo`. |
| `packages/ledger/src/repo/tracer.ts` | **Modify.** `DbTracer.startRun` writes it. |
| `apps/web/src/lib/geo.ts` | **Create.** Request headers → a coarse location, or nothing. |
| `packages/ledger/src/repo/flags.ts` | **Create.** The kill-switch read path. Owner-agnostic, tiny, deliberately separate from `admin.ts` because the *read* is not an admin read — every chat request makes it. |
| `packages/ledger/src/repo/quota.ts` | **Modify.** `'paused'` verdict. |
| `packages/ledger/src/repo/admin.ts` | **Create.** The one door. Every cross-owner read, plus the two operator actions. |
| `packages/ledger/src/admin-containment.test.ts` | **Create.** Asserts the set of modules holding the RLS-bypassing connection is the reviewed one. |
| `apps/web/src/lib/admin.ts` | **Create.** Session → `AdminSession | undefined`, against `ADMIN_EMAILS`. |
| `apps/web/src/app/admin/page.tsx` | **Create.** The dashboard. |
| `apps/web/src/app/admin/panels.tsx` | **Create.** The eight panels as presentational components. |
| `apps/web/src/app/admin/world-map.tsx` | **Create.** Inline SVG, no library, no tiles. |
| `apps/web/src/app/api/admin/action/route.ts` | **Create.** The two operator writes. |
| `packages/ledger/src/scripts/reset.ts` | **Modify.** Refuse to truncate a database that is not obviously local. |

`admin.ts` is one file rather than one file per panel, on purpose. §9.2 of the design says a reviewer should be able to answer "how could one user see another's data?" by reading one file, and that property is worth more than the tidiness of eight small modules.

---

### Task 1: Location, coarsely, per run

**Files:**
- Modify: `packages/ledger/src/schema.ts`, `packages/core/src/trace.ts`, `packages/ledger/src/repo/tracer.ts`, `apps/web/src/lib/turn.ts`, `apps/web/src/app/api/chat/route.ts`, `apps/web/src/app/api/confirm/route.ts`
- Create: `apps/web/src/lib/geo.ts`, `apps/web/src/lib/geo.test.ts`
- Test: `packages/ledger/src/repo/tracer.test.ts` (extend)

**Interfaces:**
- Produces: `RunGeo` in `packages/core/src/trace.ts`; `Tracer.startRun(info: { provider, model, channel, geo?: RunGeo })`; `requestGeo(request: Request): RunGeo | undefined` in `apps/web/src/lib/geo.ts`.

**Why per run and not per user.** Storing location on `trace_runs` means the map shows *activity* rather than a roster of people, and it ages out with trace data instead of accumulating a permanent location history for each visitor.

**Why the headers and not a geolocation service.** Vercel populates them at the edge: no third-party service, no extra network hop, no API key, no cost. Locally they are absent, so every column is nullable and the map has to render without them — which is also what happens for any request whose address cannot be resolved.

- [ ] **Step 1: Write the failing test for the header reader**

```ts
// apps/web/src/lib/geo.test.ts
import { describe, expect, it } from 'vitest'
import { requestGeo } from './geo'

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/chat', { headers })
}

describe('requestGeo', () => {
  it('reads Vercel edge headers into a coarse location', () => {
    expect(
      requestGeo(
        req({
          'x-vercel-ip-country': 'IN',
          'x-vercel-ip-country-region': 'KA',
          'x-vercel-ip-city': 'Bengaluru',
          'x-vercel-ip-latitude': '12.9716',
          'x-vercel-ip-longitude': '77.5946',
        }),
      ),
    ).toEqual({
      country: 'IN',
      region: 'KA',
      city: 'Bengaluru',
      lat: 12.9716,
      lon: 77.5946,
    })
  })

  it('returns nothing at all when the headers are absent', () => {
    // Local development, and any request whose address the edge could not
    // resolve. The columns are nullable for exactly this case.
    expect(requestGeo(req({}))).toBeUndefined()
  })

  it('decodes a percent-encoded city name', () => {
    // Vercel percent-encodes the city header, so "São Paulo" arrives as
    // "S%C3%A3o%20Paulo" and would otherwise be stored mojibaked forever.
    const geo = requestGeo(req({ 'x-vercel-ip-city': 'S%C3%A3o%20Paulo' }))
    expect(geo?.city).toBe('São Paulo')
  })

  it('drops coordinates it cannot parse rather than storing NaN', () => {
    const geo = requestGeo(
      req({ 'x-vercel-ip-country': 'IN', 'x-vercel-ip-latitude': 'not-a-number' }),
    )
    expect(geo).toEqual({ country: 'IN' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/src/lib/geo.test.ts`
Expected: FAIL — `Cannot find module './geo'`.

Note: `vitest.config.ts` currently includes `packages` and `tests`. If this file is not picked up, add `apps/web/src/**/*.test.ts` to the `include` array in the same commit and say so.

- [ ] **Step 3: Write the header reader**

```ts
// apps/web/src/lib/geo.ts
import type { RunGeo } from '@kakeibo/core/trace'

/**
 * The visitor's approximate location, from the request itself.
 *
 * This is not the browser Geolocation API and never prompts: that prompt
 * exists for precise device location, which this deliberately is not. Vercel
 * resolves the address at the edge and hands over a city — a neighbourhood, not
 * an address — and the raw address is read, coarsened and discarded inside this
 * function. Nothing downstream ever sees it.
 *
 * Returns undefined rather than an object of nulls when there is nothing to
 * read, so a caller cannot accidentally store a row of blanks that looks like a
 * failed lookup instead of an absent one.
 */
export function requestGeo(request: Request): RunGeo | undefined {
  const header = (name: string): string | undefined => {
    const raw = request.headers.get(name)
    if (!raw) return undefined
    // Vercel percent-encodes these, so "São Paulo" arrives as
    // "S%C3%A3o%20Paulo" and would be stored mojibaked forever.
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }

  const number = (name: string): number | undefined => {
    const raw = header(name)
    if (raw === undefined) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  const geo: RunGeo = {
    ...(header('x-vercel-ip-country') ? { country: header('x-vercel-ip-country')! } : {}),
    ...(header('x-vercel-ip-country-region')
      ? { region: header('x-vercel-ip-country-region')! }
      : {}),
    ...(header('x-vercel-ip-city') ? { city: header('x-vercel-ip-city')! } : {}),
    ...(number('x-vercel-ip-latitude') !== undefined
      ? { lat: number('x-vercel-ip-latitude')! }
      : {}),
    ...(number('x-vercel-ip-longitude') !== undefined
      ? { lon: number('x-vercel-ip-longitude')! }
      : {}),
  }

  return Object.keys(geo).length > 0 ? geo : undefined
}
```

- [ ] **Step 4: Add `RunGeo` to the tracer interface**

In `packages/core/src/trace.ts`, above `Tracer`:

```ts
/**
 * A coarse, city-level location for one turn.
 *
 * Provider-neutral by design: core must not learn what Vercel is. Every field
 * is optional because the edge resolves some addresses only partially, and all
 * of them are absent in local development.
 */
export interface RunGeo {
  country?: string
  region?: string
  city?: string
  lat?: number
  lon?: number
}
```

and widen both the interface and every implementation's `startRun`:

```ts
startRun(info: {
  provider: string
  model: string
  channel: Channel
  geo?: RunGeo
}): Promise<TraceRunHandle>
```

`InMemoryTracer.startRun` already spreads `...info` into the stored run, so it needs no change beyond the type. `NoopTracer` likewise.

- [ ] **Step 5: Add the columns and write them**

In `packages/ledger/src/schema.ts`, inside `traceRuns`, after `channel`:

```ts
/**
 * Coarse location, from the request address at the edge (spec §9.5).
 *
 * All nullable: absent in local development and for any address the edge
 * cannot resolve, which the map is required to render without complaint.
 * Stored per run rather than per user so the map shows activity rather than a
 * roster of people, and so it ages out with trace data.
 */
geoCountry: char('geo_country', { length: 2 }),
geoRegion: text('geo_region'),
geoCity: text('geo_city'),
geoLat: doublePrecision('geo_lat'),
geoLon: doublePrecision('geo_lon'),
```

Add `doublePrecision` to the `drizzle-orm/pg-core` import.

In `packages/ledger/src/repo/tracer.ts`, `DbTracer.startRun`:

```ts
await withOwner(owner, (tx) =>
  tx.insert(traceRuns).values({
    id,
    ownerId: owner,
    provider: info.provider,
    model: info.model,
    channel: info.channel,
    geoCountry: info.geo?.country ?? null,
    geoRegion: info.geo?.region ?? null,
    geoCity: info.geo?.city ?? null,
    geoLat: info.geo?.lat ?? null,
    geoLon: info.geo?.lon ?? null,
  }),
)
```

- [ ] **Step 6: Thread it through the web routes**

`agentDependencies` in `apps/web/src/lib/turn.ts` builds the tracer, so it takes the location:

```ts
export function agentDependencies(owner: OwnerId, geo?: RunGeo) {
  const config = env()
  return {
    adapter: createAdapter(),
    registry: createRegistry(owner),
    tracer: new DbTracer(owner, geo),
    // ...unchanged
  }
}
```

and `DbTracer`'s constructor takes it alongside the owner:

```ts
constructor(
  private readonly owner: OwnerId,
  private readonly geo?: RunGeo,
) {}
```

with `startRun` preferring its argument and falling back to the constructor value, so the CLI, MCP and eval callers that pass no location keep working unchanged.

Both routes then pass `requestGeo(request)`:

```ts
const result = await runTurn({
  ...agentDependencies(owner, requestGeo(request)),
  // ...unchanged
})
```

- [ ] **Step 7: Extend the tracer test**

```ts
// append to packages/ledger/src/repo/tracer.test.ts
it('stores a location when one was resolved, and nulls when it was not', async () => {
  const tracer = new DbTracer(owner)

  const located = await tracer.startRun({
    provider: 'gemini',
    model: 'test',
    channel: 'web',
    geo: { country: 'IN', region: 'KA', city: 'Bengaluru', lat: 12.9716, lon: 77.5946 },
  })
  await located.finish({
    status: 'ok',
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, thoughtTokens: 0 },
    costUsdEst: 0,
    latencyMs: 1,
  })

  const anonymousLocation = await tracer.startRun({
    provider: 'gemini',
    model: 'test',
    channel: 'cli',
  })
  await anonymousLocation.finish({
    status: 'ok',
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, thoughtTokens: 0 },
    costUsdEst: 0,
    latencyMs: 1,
  })

  const rows = await listRuns(owner, 50)
  const withGeo = rows.find((r) => r.id === located.id)
  const withoutGeo = rows.find((r) => r.id === anonymousLocation.id)

  expect(withGeo?.geoCity).toBe('Bengaluru')
  expect(withGeo?.geoLat).toBeCloseTo(12.9716, 4)
  // A local run stores nulls and must not become a point at (0, 0) in the
  // Gulf of Guinea, which is where "default the coordinates" always lands.
  expect(withoutGeo?.geoLat).toBeNull()
  expect(withoutGeo?.geoCountry).toBeNull()
})
```

This test shares its owner with the existing `resuming a run` test, which asserts `listRuns(owner, 50)` has length 1. Change that assertion to filter for the run it created (`rows.filter((r) => r.id === run.id)`) rather than counting the whole list — a count assertion that breaks when a neighbouring test adds a row is testing the wrong thing.

- [ ] **Step 8: Generate and apply the migration**

```bash
cd packages/ledger && npx drizzle-kit generate && cd ../.. && pnpm db:migrate
```

Verify: `select count(*) from information_schema.columns where table_name='trace_runs' and column_name like 'geo\_%'` returns 5.

- [ ] **Step 9: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add -A
git commit -m "Record a coarse location per turn

From the request address at the edge, not the browser Geolocation API - that
prompt exists for precise device location, which this deliberately is not.
Vercel resolves it for free at the edge, so there is no third-party service, no
extra hop and no key.

Stored on trace_runs rather than on the user, so the map shows activity rather
than a roster of people and it ages out with trace data instead of accumulating
a permanent location history.

Every column is nullable and requestGeo returns undefined rather than an object
of nulls: local development has no such headers, and a run with no location must
stay absent from the map rather than becoming a point at (0, 0)."
```

---

### Task 2: `pnpm db:reset` refuses a database it does not recognise

**Files:**
- Modify: `packages/ledger/src/scripts/reset.ts`, `packages/evals/src/runner.ts`, `packages/core/src/env.ts`, `.env.example`
- Create: `packages/ledger/src/scripts/reset-guard.test.ts`

**Interfaces:**
- Produces: `assertResettable(databaseUrl: string, allowDestructive: boolean): void` exported from `packages/ledger/src/scripts/reset.ts`.

**Why now, before there is a production database.** `resetAndSeed` truncates every ledger table and runs before every eval task. The day a production `DATABASE_URL` is within reach of a local shell is the day someone runs `pnpm eval` with the wrong `.env` loaded. A guard written afterwards is written after the incident.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ledger/src/scripts/reset-guard.test.ts
import { describe, expect, it } from 'vitest'
import { assertResettable } from './reset'

const LOCAL = 'postgres://kakeibo:kakeibo@localhost:5433/kakeibo'
const NEON = 'postgres://user:pw@ep-cool-name-123456.ap-south-1.aws.neon.tech/kakeibo'

describe('assertResettable', () => {
  it('allows localhost', () => {
    expect(() => assertResettable(LOCAL, false)).not.toThrow()
    expect(() => assertResettable('postgres://x@127.0.0.1:5433/db', false)).not.toThrow()
    expect(() => assertResettable('postgres://x@[::1]:5433/db', false)).not.toThrow()
  })

  it('refuses anything else', () => {
    expect(() => assertResettable(NEON, false)).toThrow(/refusing/i)
    // The message has to name the host, or the person who hits this at 2am
    // cannot tell which database they were pointed at.
    expect(() => assertResettable(NEON, false)).toThrow(/neon\.tech/)
  })

  it('allows anything when the escape hatch is set explicitly', () => {
    expect(() => assertResettable(NEON, true)).not.toThrow()
  })

  it('refuses a url it cannot parse rather than assuming it is local', () => {
    // Failing closed matters more here than a helpful error: the cost of a
    // false refusal is retyping a command.
    expect(() => assertResettable('not a url', false)).toThrow(/refusing/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ledger/src/scripts/reset-guard.test.ts`
Expected: FAIL — `assertResettable is not exported`.

- [ ] **Step 3: Write the guard**

In `packages/ledger/src/scripts/reset.ts`, above `main`:

```ts
/**
 * Refuses to truncate a database that is not obviously a local one.
 *
 * `pnpm eval` calls resetAndSeed before every task, so this code path runs
 * constantly and truncates every ledger table. The failure mode it exists to
 * prevent is not subtle: a production DATABASE_URL in a local shell, one
 * `pnpm eval`, and the ledger is gone.
 *
 * Fails closed on anything it cannot parse. The cost of a false refusal is
 * retyping a command with ALLOW_DESTRUCTIVE_RESET=1.
 */
export function assertResettable(databaseUrl: string, allowDestructive: boolean): void {
  if (allowDestructive) return

  let host: string
  try {
    host = new URL(databaseUrl).hostname
  } catch {
    throw new Error(
      'Refusing to reset: DATABASE_URL could not be parsed, so its host is unknown. ' +
        'Set ALLOW_DESTRUCTIVE_RESET=1 if you are certain.',
    )
  }

  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  if (!local) {
    throw new Error(
      `Refusing to reset a non-local database (host: ${host}). ` +
        'This truncates every ledger table. Set ALLOW_DESTRUCTIVE_RESET=1 if you are certain.',
    )
  }
}
```

Call it at the top of `main`:

```ts
assertResettable(env().DATABASE_URL, env().ALLOW_DESTRUCTIVE_RESET)
```

and at the top of `resetAndSeed` in `packages/evals/src/runner.ts`, which truncates through its own path and would otherwise be an unguarded second door:

```ts
export async function resetAndSeed(): Promise<void> {
  assertResettable(env().DATABASE_URL, env().ALLOW_DESTRUCTIVE_RESET)
  await getDb().execute(/* unchanged */)
  // ...
}
```

New env in `packages/core/src/env.ts`, beside the other `boolish` entries:

```ts
/**
 * Lets `db:reset` and the eval harness truncate a database that is not
 * localhost. Off by default; the only reason to turn it on is a deliberate
 * reset of a hosted development database.
 */
ALLOW_DESTRUCTIVE_RESET: boolish.default(false),
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/ledger/src/scripts/reset-guard.test.ts
pnpm db:reset && pnpm db:seed
```

Expected: 4 tests pass, and the local reset still works.

- [ ] **Step 5: Add it to `.env.example` and commit**

```
ALLOW_DESTRUCTIVE_RESET=0         # db:reset and evals refuse a non-localhost database without this
```

```bash
git add -A
git commit -m "Refuse to truncate a database that is not obviously local

resetAndSeed runs before every eval task and truncates every ledger table. The
failure mode is a production DATABASE_URL in a local shell and one pnpm eval.

Guarded in both places that truncate - the script and the eval harness - because
a guard on one of two doors is decoration. It fails closed on a url it cannot
parse, since the cost of a false refusal is retyping a command."
```

---

### Task 3: The kill switch, read path first

**Files:**
- Modify: `packages/ledger/src/schema.ts`, `packages/ledger/src/repo/quota.ts`, `packages/ledger/src/index.ts`, `apps/web/src/lib/turn.ts`
- Create: `packages/ledger/src/repo/flags.ts`
- Test: `packages/ledger/src/repo/quota.test.ts` (extend)

**Interfaces:**
- Produces: `operatorFlags` table; `isLiveChatPaused(): Promise<boolean>` and `setFlag(key: OperatorFlag, value: boolean): Promise<void>` in `packages/ledger/src/repo/flags.ts`; `QuotaReason` gains `'paused'`.

**Why a table rather than an env var.** An env var change is a redeploy, and the point of a kill switch is that it works during an incident, from a phone, in seconds.

**Why this is not in `admin.ts`.** The *read* happens on every chat request and is owner-agnostic — it is not an admin read, and putting it behind the admin door would mean every visitor's request passing through the module whose whole purpose is being the one place with cross-owner reach. The *write* is an operator action and does live in `admin.ts` (Task 8).

- [ ] **Step 1: Add the table**

```ts
// packages/ledger/src/schema.ts
/**
 * Operator switches (spec §9.4).
 *
 * A table rather than an environment variable because an env change is a
 * redeploy, and the point of a kill switch is that it works during an incident,
 * from a phone, in seconds. Not owner-scoped and deliberately without an RLS
 * policy: it is a property of the site, not of a visitor.
 */
export const operatorFlags = pgTable('operator_flags', {
  key: text('key').primaryKey(),
  value: boolean('value').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type OperatorFlagRow = typeof operatorFlags.$inferSelect
```

Add `boolean` to the `drizzle-orm/pg-core` import.

- [ ] **Step 2: Write the failing test**

```ts
// append to packages/ledger/src/repo/quota.test.ts, inside describe('consumeQuota')
it('refuses everyone while live chat is paused, and lets them back afterwards', async () => {
  // The manual kill switch, independent of the budget trip. It has to stop
  // resumes too: pausing during an incident that is only ever going to stop
  // *new* turns is not a kill switch.
  await setFlag('live_chat_paused', true)
  expect(await consumeQuota({ owner: solo, isAnonymous: true, kind: 'message' })).toMatchObject({
    allowed: false,
    reason: 'paused',
  })
  expect(await consumeQuota({ owner: solo, isAnonymous: false, kind: 'resume' })).toMatchObject({
    allowed: false,
    reason: 'paused',
  })

  await setFlag('live_chat_paused', false)
  expect((await consumeQuota({ owner: solo, isAnonymous: true, kind: 'message' })).allowed).toBe(
    true,
  )
})
```

Import `setFlag` from `./flags`. Place this test **before** the `stops everyone once the day costs more than the ceiling` test, which lowers the budget and leaves it lowered.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/ledger/src/repo/quota.test.ts -t paused`
Expected: FAIL — `Cannot find module './flags'`.

- [ ] **Step 4: Write the flags module and the quota branch**

```ts
// packages/ledger/src/repo/flags.ts
import { eq } from 'drizzle-orm'
import { adminDb } from '../db'
import { operatorFlags } from '../schema'

/**
 * Site-wide operator switches (spec §9.4).
 *
 * Read on every chat request, which is why this is its own tiny module rather
 * than part of `admin.ts`: that module exists to be the one place with
 * cross-owner reach, and routing every visitor's request through it would blunt
 * the point. The *write* is an operator action and does live there.
 */

export type OperatorFlag = 'live_chat_paused'

export async function isFlagSet(key: OperatorFlag): Promise<boolean> {
  const [row] = await adminDb()
    .select({ value: operatorFlags.value })
    .from(operatorFlags)
    .where(eq(operatorFlags.key, key))
    .limit(1)
  // Absent means off. A kill switch that fails *on* would take the site down
  // the first time this table is empty, which is every fresh database.
  return row?.value === true
}

export async function setFlag(key: OperatorFlag, value: boolean): Promise<void> {
  await adminDb()
    .insert(operatorFlags)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: operatorFlags.key, set: { value, updatedAt: new Date() } })
}

export const isLiveChatPaused = (): Promise<boolean> => isFlagSet('live_chat_paused')
```

In `packages/ledger/src/repo/quota.ts`, widen the reason and check it beside the blocked check:

```ts
export type QuotaReason = 'paused' | 'blocked' | 'owner_quota' | 'ip_quota' | 'daily_cap'
```

```ts
// Cheapest first, and these two are both the cheapest and the most absolute.
if (await isLiveChatPaused()) return { allowed: false, reason: 'paused' }
if (await isBlocked(input.owner)) return { allowed: false, reason: 'blocked' }
```

In `apps/web/src/lib/turn.ts`, `quotaRefusal` gains the message:

```ts
paused: 'kakeibo’s live chat is paused. The recorded demo still works.',
```

- [ ] **Step 5: Generate the migration, run the tests**

```bash
cd packages/ledger && npx drizzle-kit generate && cd ../.. && pnpm db:migrate
pnpm lint && pnpm typecheck && pnpm test
```

Expected: all green, including the new quota test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add the live-chat kill switch, read path

A table rather than an environment variable, because an env change is a redeploy
and the point of a kill switch is that it works during an incident, from a
phone, in seconds.

Absent means off. A switch that failed *on* would take the site down the first
time the table is empty, which is every fresh database.

It stops resumes as well as new turns. A pause that only stops turns nobody has
started yet is not a kill switch.

The read lives outside admin.ts on purpose: it happens on every chat request and
is owner-agnostic, and routing every visitor through the module whose whole
purpose is being the one place with cross-owner reach would blunt the point. The
write is an operator action and lands there in a later task."
```

---

### Task 4: The one door

**Files:**
- Create: `packages/ledger/src/repo/admin.ts`, `packages/ledger/src/admin-containment.test.ts`, `apps/web/src/lib/admin.ts`
- Modify: `packages/core/src/env.ts`, `packages/ledger/src/index.ts`, `.env.example`

**Interfaces:**
- Produces: `AdminSession` and `assertAdmin` in `packages/ledger/src/repo/admin.ts`; `adminSession(): Promise<AdminSession | undefined>` in `apps/web/src/lib/admin.ts`.
- Consumes: `viewerOwner()` from `apps/web/src/lib/owner.ts`.

**The security-critical task.** Everything after this one adds functions to a module that can read across every owner, which is precisely what Plan A's row-level security exists to prevent. This task builds the door and the test that says there is only one.

**A correction to the spec.** §11 asks for a grep test that "the RLS-bypassing role is referenced in `repo/admin.ts` and nowhere else". That test is unsatisfiable as written, and was already unsatisfiable when it was written: `adminDb()` is used by `testing.ts`, `link.ts`, `users.ts`, `quota.ts`, `reaper.ts`, `flags.ts` and both scripts, for reasons that have nothing to do with reading one visitor's ledger from another's session — repointing spans exactly two named owners, `user` and `rate_limits` have no `owner_id` to scope by, and the maintenance scripts are not the application. Enforcing the sentence literally would mean either weakening those or writing a test that is permanently skipped.

What the spec actually wants is that the set of modules holding that reach is small, deliberate and reviewed. So the test asserts the set **equals** a named allowlist, with each entry carrying the reason it is there. Adding a module to it is then a visible act in a diff, which is the property that was wanted.

- [ ] **Step 1: Write the failing containment test**

```ts
// packages/ledger/src/admin-containment.test.ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The RLS-bypassing connection is `adminDb()`. Row-level security is the
 * backstop under every owner-scoped query, and a module holding this connection
 * is a module for which that backstop does not apply.
 *
 * The spec (§11) asks for "referenced in repo/admin.ts and nowhere else". Taken
 * literally that is unsatisfiable — several modules need the unscoped
 * connection for reasons that are not "read one visitor's data from another's
 * session" — so this asserts the stronger practical property instead: the set of
 * holders EQUALS a reviewed list, and each entry says why. Adding one is then a
 * visible act in a diff rather than a silent widening.
 *
 * If this test fails because you added a module, do not add it to the list
 * reflexively. Ask first whether the query could be owner-scoped instead.
 */
const ALLOWED = new Map<string, string>([
  ['src/db.ts', 'defines adminDb()'],
  ['src/repo/admin.ts', 'the operator dashboard: the only cross-owner reads in the application'],
  ['src/repo/link.ts', 'repointing and deletion span exactly two named owners, which RLS forbids'],
  ['src/repo/users.ts', '"user" is the principal table, outside RLS, and app_user has no rights on it'],
  ['src/repo/quota.ts', 'the global cap sums every owner; rate_limits has no owner_id'],
  ['src/repo/flags.ts', 'operator_flags is a property of the site, not of a visitor'],
  ['src/repo/reaper.ts', 'maintenance: deletes expired users across the whole table'],
  ['src/testing.ts', 'test teardown, which must work whether or not the policies are applied'],
  ['src/scripts/seed.ts', 'seeding writes rows for an owner that has no session'],
  ['src/scripts/reset.ts', 'truncates every owner, which is exactly what app_user must not do'],
  ['src/scripts/reap.ts', 'the reaper as a command'],
])

function sourceFiles(dir: string, base: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, base, found)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      found.push(full.slice(base.length + 1))
    }
  }
  return found
}

describe('the RLS bypass is contained', () => {
  it('is held by exactly the reviewed set of modules', () => {
    const base = join(__dirname, '..')
    const holders = sourceFiles(join(base, 'src'), base)
      .filter((file) => /\badminDb\s*\(/.test(readFileSync(join(base, file), 'utf8')))
      .sort()

    expect(holders).toEqual([...ALLOWED.keys()].sort())
  })

  it('is not held anywhere outside the ledger package', () => {
    // The web app, the CLI, the MCP server and the eval harness all reach the
    // database through @kakeibo/ledger. If one of them imports adminDb
    // directly, the single door has a window beside it.
    const repoRoot = join(__dirname, '..', '..', '..')
    const outside = ['apps', 'packages/core', 'packages/mcp', 'packages/evals', 'scripts']
      .flatMap((dir) => {
        try {
          return sourceFiles(join(repoRoot, dir), repoRoot)
        } catch {
          return []
        }
      })
      .filter((file) => /\badminDb\b/.test(readFileSync(join(repoRoot, file), 'utf8')))

    expect(outside).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ledger/src/admin-containment.test.ts`
Expected: FAIL — `src/repo/admin.ts` is in the allowlist but does not exist yet, so the two arrays differ.

- [ ] **Step 3: Write the door**

```ts
// packages/ledger/src/repo/admin.ts
import { env } from '@kakeibo/core/env'
import { adminDb } from '../db'

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
 * A branded type with a private symbol: it cannot be forged with an object
 * literal, so `readEverything({ email } as AdminSession)` does not compile.
 * That is the whole mechanism — the type is the capability.
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
```

- [ ] **Step 4: Add the env var**

In `packages/core/src/env.ts`:

```ts
/**
 * Comma-separated emails allowed to reach /admin. Empty means nobody, which
 * is the right default: an empty allowlist that granted access would make a
 * missing environment variable an open dashboard.
 */
ADMIN_EMAILS: z.string().default(''),
```

In `.env.example`:

```
# Comma-separated emails allowed to reach /admin. Empty means nobody.
ADMIN_EMAILS=
```

- [ ] **Step 5: Write the web-side session check**

```ts
// apps/web/src/lib/admin.ts
import { type AdminSession, assertAdmin } from '@kakeibo/ledger'
import { viewerOwner } from '@/lib/owner'

/**
 * The operator's session, or undefined.
 *
 * Callers respond to undefined with `notFound()`, never a 403. A 403 confirms
 * the route exists, which is free reconnaissance for anyone probing a public
 * site; a 404 is indistinguishable from a typo.
 */
export async function adminSession(): Promise<AdminSession | undefined> {
  const viewer = await viewerOwner()
  // An anonymous visitor has a synthetic email on a domain nobody controls, so
  // this is not merely belt and braces: it stops an allowlist entry from ever
  // being satisfiable by a generated address.
  if (!viewer || viewer.isAnonymous) return undefined
  return assertAdmin(viewer.email)
}
```

- [ ] **Step 6: Write the authorization test**

```ts
// packages/ledger/src/repo/admin.test.ts
import { resetEnvCache } from '@kakeibo/core/env'
import { afterEach, describe, expect, it } from 'vitest'
import { assertAdmin } from './admin'

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
```

- [ ] **Step 7: Run the tests**

```bash
npx vitest run packages/ledger/src/admin-containment.test.ts packages/ledger/src/repo/admin.test.ts
pnpm lint && pnpm typecheck && pnpm test
```

Expected: all green. `unscoped()` is unused at this point — Biome's `noUnusedVariables` covers variables, not module-private functions, but if it complains, add the first panel from Task 5 in the same commit rather than exporting `unscoped`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Add the one door the admin dashboard reads through

Everything after this adds functions to a module that reads across every owner,
which is precisely what Plan A's row-level security exists to prevent. So the
door comes first, with the test that says there is only one.

AdminSession is a branded type with a private symbol: it cannot be built with an
object literal, so a caller cannot reach these reads without having proved who
they are. Authorization is checked once, at the door, rather than in every
function - one check is easier to audit than eleven.

The containment test departs from spec §11, which asks for a grep proving the
RLS-bypassing connection is used in repo/admin.ts and nowhere else. That is
unsatisfiable and always was: repointing spans two named owners, \"user\" and
rate_limits have no owner_id to scope by, and the maintenance scripts are not
the application. The test asserts the property actually wanted instead - that
the set of holders equals a reviewed list, each with its reason - so widening it
is a visible act in a diff.

An empty ADMIN_EMAILS admits nobody. The opposite default would make a missing
environment variable an open dashboard."
```

---

### Task 5: Budget and traffic

**Files:**
- Modify: `packages/ledger/src/repo/admin.ts`, `packages/ledger/src/index.ts`
- Test: `packages/ledger/src/repo/admin.test.ts` (extend)

**Interfaces:**
- Produces:

```ts
export interface BudgetPanel {
  todayUsd: number
  monthToDateUsd: number
  projectedMonthUsd: number
  dailyCapUsd: number
  monthlyCeilingUsd: number
  state: 'ok' | 'tripped' | 'paused'
  sparkline: { day: string; usd: number }[]   // 30 entries, oldest first, gaps filled with 0
}

export interface TrafficPanel {
  visitors: { today: number; d7: number; d30: number }
  anonymous: number
  signedIn: number
  conversionPercent: number
  returning: number
}

export function budgetPanel(session: AdminSession): Promise<BudgetPanel>
export function trafficPanel(session: AdminSession): Promise<TrafficPanel>
```

**Why budget is first and largest.** It is the number that can hurt: the $20 ceiling is on a personal card, and a surprise there is a surprise on a bill.

**Gaps in the sparkline are filled with zero, not omitted.** A 30-day series that silently skips quiet days compresses the x-axis and makes a flat month look like steady traffic.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/ledger/src/repo/admin.test.ts
import { adminDb, closeDb } from '../db'
import { asOwnerId } from '../owner'
import { resetOwners } from '../testing'
import { budgetPanel, trafficPanel } from './admin'
import { traceRuns } from '../schema'
import { user } from '../auth-schema'
import { eq, sql } from 'drizzle-orm'

const alice = asOwnerId('00000000-0000-4000-8000-0000000ad001')
const bob = asOwnerId('00000000-0000-4000-8000-0000000ad002')

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
  beforeAll(async () => {
    await resetOwners(alice, bob)
    await runOn(alice, 0, 0.01)
    await runOn(alice, 0, 0.02)
    await runOn(alice, 3, 0.05)
    await runOn(bob, 0, 0.005)
  }, 60_000)

  afterAll(async () => {
    await resetOwners(alice, bob)
    await closeDb()
  })

  it('sums every owner, not just the operator', async () => {
    const panel = await budgetPanel(session())
    // 0.01 + 0.02 from Alice and 0.005 from Bob. A dashboard that showed only
    // the operator's own spend would report zero on a site with real traffic.
    expect(panel.todayUsd).toBeCloseTo(0.035, 6)
  })

  it('returns a 30-entry sparkline with quiet days at zero', async () => {
    const panel = await budgetPanel(session())
    expect(panel.sparkline).toHaveLength(30)
    // Oldest first, so it reads left to right like the chart it becomes.
    expect(panel.sparkline[0]!.day < panel.sparkline[29]!.day).toBe(true)
    expect(panel.sparkline.at(-1)!.usd).toBeCloseTo(0.035, 6)
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
    delete process.env.GLOBAL_DAILY_BUDGET_USD
    resetEnvCache()
  })
})

describe('trafficPanel', () => {
  it('counts visitors by kind and reports the conversion rate', async () => {
    const panel = await trafficPanel(session())
    expect(panel.visitors.today).toBeGreaterThanOrEqual(2)
    expect(panel.anonymous + panel.signedIn).toBe(panel.visitors.d30)
    // A percentage, not a fraction: 0..100, and 0 rather than NaN when there
    // is nobody at all.
    expect(panel.conversionPercent).toBeGreaterThanOrEqual(0)
    expect(panel.conversionPercent).toBeLessThanOrEqual(100)
  })
})
```

Add a shared helper near the top of the file, after the `assertAdmin` tests:

```ts
/** An AdminSession for tests, built the only way one can be built. */
function session(): AdminSession {
  process.env.ADMIN_EMAILS = 'operator@example.com'
  resetEnvCache()
  const admin = assertAdmin('operator@example.com')
  if (!admin) throw new Error('the allowlist should have admitted this')
  return admin
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ledger/src/repo/admin.test.ts`
Expected: FAIL — `budgetPanel is not exported`.

- [ ] **Step 3: Implement both panels**

```ts
// packages/ledger/src/repo/admin.ts
import { and, count, countDistinct, eq, gte, isNotNull, sql } from 'drizzle-orm'
import { user } from '../auth-schema'
import { traceRuns } from '../schema'
import { isLiveChatPaused } from './flags'

const DAYS = 30

export async function budgetPanel(_session: AdminSession): Promise<BudgetPanel> {
  const config = env()
  const db = unscoped()

  // One scan, bucketed by day, rather than 30 queries. At ~148 turns a day
  // this stays fast for years, which is why §9.3 rules out rollup tables.
  const rows = await db
    .select({
      day: sql<string>`to_char(${traceRuns.startedAt}, 'YYYY-MM-DD')`,
      usd: sql<string>`coalesce(sum(${traceRuns.costUsdEst}), 0)`,
    })
    .from(traceRuns)
    .where(gte(traceRuns.startedAt, sql`current_date - ${DAYS - 1} * interval '1 day'`))
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
    .where(gte(traceRuns.startedAt, sql`date_trunc('month', current_date)`))

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

export async function trafficPanel(_session: AdminSession): Promise<TrafficPanel> {
  const db = unscoped()

  const active = async (days: number): Promise<number> => {
    const [row] = await db
      .select({ n: countDistinct(traceRuns.ownerId) })
      .from(traceRuns)
      .where(gte(traceRuns.startedAt, sql`current_date - ${days} * interval '1 day'`))
    return Number(row?.n ?? 0)
  }

  const [kinds] = await db
    .select({
      anonymous: sql<string>`count(*) filter (where ${user.isAnonymous} is true)`,
      signedIn: sql<string>`count(*) filter (where ${user.isAnonymous} is not true)`,
    })
    .from(user)

  const anonymous = Number(kinds?.anonymous ?? 0)
  const signedIn = Number(kinds?.signedIn ?? 0)
  const total = anonymous + signedIn

  // Distinct owners with a run in the window, not rows in "user": the reaper
  // deletes anonymous visitors after 24 hours, so counting the table would
  // undercount yesterday and overcount nothing.
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
    visitors: { today: await active(0), d7: await active(7), d30: await active(30) },
    anonymous,
    signedIn,
    // 0 rather than NaN on an empty site, which is every site on day one.
    conversionPercent: total === 0 ? 0 : Math.round((signedIn / total) * 1000) / 10,
    returning: Number(returningRow?.n ?? 0),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/ledger/src/repo/admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add the budget and traffic panels

Budget first and largest because it is the number that can hurt: the ceiling is
on a personal card and a surprise there is a surprise on a bill.

The 30-day series is one bucketed scan rather than thirty queries, and quiet
days are filled with zero rather than omitted - a sparse series compresses the
x-axis and makes a flat month look like steady traffic. The month projection is
clamped at month-to-date, because a projection that undercuts money already
spent is worse than none.

Traffic counts distinct owners with a run in the window rather than rows in
\"user\": the reaper deletes anonymous visitors after 24 hours, so the table is
not a record of who was here. Conversion is 0 rather than NaN on an empty site,
which is every site on day one."
```

---

### Task 6: Health, safety and tools

**Files:**
- Modify: `packages/ledger/src/repo/admin.ts`, `packages/ledger/src/index.ts`
- Test: `packages/ledger/src/repo/admin.test.ts` (extend)

**Interfaces:**
- Produces:

```ts
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

export function healthPanel(session: AdminSession): Promise<HealthPanel>
export function safetyPanel(session: AdminSession): Promise<SafetyPanel>
export function toolsPanel(session: AdminSession): Promise<ToolStat[]>
```

**How a confirmation is counted, exactly.** This is the fiddly part and getting it wrong makes the Safety panel lie. A write under the `suspend` policy produces **two** `confirm` events: one at suspension with `allowed: null` and `suspended: true`, and one at resume with `allowed: true | false`. A write under `inline`/`auto-*` produces **one**, with `allowed` already set. Both carry the same `payload.id` within a run for the suspend pair. So:

- `allowed` = events where `payload->>'allowed' = 'true'`
- `declined` = events where `payload->>'allowed' = 'false'`
- `awaiting` = suspension events with no answered sibling sharing `(run_id, payload->>'id')` — an abandoned confirmation card
- `proposed` = the sum of the three

Counting rows naively would double every suspended write.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/ledger/src/repo/admin.test.ts
import { traceEvents } from '../schema'
import { healthPanel, safetyPanel, toolsPanel } from './admin'

const audited = asOwnerId('00000000-0000-4000-8000-0000000ad003')

/** Writes a run and its events exactly as the loop would. */
async function auditedRun(events: { type: string; payload: object; latencyMs?: number }[]) {
  const [run] = await adminDb()
    .insert(traceRuns)
    .values({
      ownerId: audited,
      provider: 'test',
      model: 'test',
      channel: 'web',
      status: 'ok',
      latencyMs: 1000,
    })
    .returning({ id: traceRuns.id })

  await adminDb().insert(traceEvents).values(
    events.map((event, seq) => ({
      ownerId: audited,
      runId: run!.id,
      seq,
      type: event.type as 'confirm' | 'tool_call' | 'error' | 'model_call',
      payload: event.payload,
      latencyMs: event.latencyMs ?? null,
    })),
  )
  return run!.id
}

describe('safetyPanel', () => {
  beforeAll(async () => {
    await resetOwners(audited)
    // One suspended write that was allowed: two events, one decision.
    await auditedRun([
      { type: 'confirm', payload: { id: 'w1', tool: 'set_budget', allowed: null, suspended: true } },
      { type: 'confirm', payload: { id: 'w1', tool: 'set_budget', allowed: true } },
      { type: 'tool_call', payload: { name: 'set_budget', tier: 'write' }, latencyMs: 12 },
    ])
    // One suspended write that was declined.
    await auditedRun([
      { type: 'confirm', payload: { id: 'w2', tool: 'set_budget', allowed: null, suspended: true } },
      { type: 'confirm', payload: { id: 'w2', tool: 'set_budget', allowed: false } },
    ])
    // One abandoned: the card was shown and nobody ever answered it.
    await auditedRun([
      { type: 'confirm', payload: { id: 'w3', tool: 'set_budget', allowed: null, suspended: true } },
    ])
    // One inline decision, which produces a single event.
    await auditedRun([
      { type: 'confirm', payload: { id: 'w4', tool: 'memory_save', allowed: true } },
      { type: 'tool_call', payload: { name: 'memory_save', tier: 'write' }, latencyMs: 4 },
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
})

describe('toolsPanel', () => {
  it('reports calls, error rate and median latency per tool', async () => {
    const stats = await toolsPanel(session())
    const setBudget = stats.find((stat) => stat.name === 'set_budget')
    expect(setBudget?.calls).toBe(1)
    expect(setBudget?.medianLatencyMs).toBe(12)
    expect(setBudget?.errorPercent).toBe(0)
  })

  it('sorts by call count so the busiest tool is first', async () => {
    const stats = await toolsPanel(session())
    for (let i = 1; i < stats.length; i++) {
      expect(stats[i - 1]!.calls).toBeGreaterThanOrEqual(stats[i]!.calls)
    }
  })
})

describe('healthPanel', () => {
  it('reports the status split and latency percentiles', async () => {
    const panel = await healthPanel(session())
    expect(panel.byStatus.ok).toBeGreaterThanOrEqual(4)
    expect(panel.p95LatencyMs).toBeGreaterThanOrEqual(panel.p50LatencyMs)
    // A percentage, and 0 rather than NaN when no tool has run at all.
    expect(panel.toolErrorPercent).toBeGreaterThanOrEqual(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ledger/src/repo/admin.test.ts -t safetyPanel`
Expected: FAIL — `safetyPanel is not exported`.

- [ ] **Step 3: Implement the three panels**

```ts
// packages/ledger/src/repo/admin.ts
const WINDOW = sql`current_date - 30 * interval '1 day'`

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
    toolErrorPercent: calls === 0 ? 0 : Math.round((errors / calls) * 1000) / 10,
  }
}

export async function safetyPanel(_session: AdminSession): Promise<SafetyPanel> {
  const db = unscoped()

  // A suspended write writes two confirm events: one when the turn pauses,
  // with allowed null, and one when it is answered. Counting rows would double
  // every one of them. Decided events are counted directly; a pause with no
  // answered sibling sharing (run_id, payload id) is a card nobody answered.
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
    .select({ n: count() })
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
        isNotNull(sql`${traceEvents.payload}->>'name'`),
        gte(traceRuns.startedAt, WINDOW),
      ),
    )
    .groupBy(sql`1`)

  return rows
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
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/ledger/src/repo/admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add the health, safety and tools panels

The safety panel counts decisions, not events. A write under the suspend policy
records two confirm events - one when the turn pauses with allowed null, one
when it is answered - so counting rows would double every suspended write and
report the guardrail as busier than it is. A pause with no answered sibling is a
card nobody ever answered, which is worth seeing separately from a decline.

Percentiles come from percentile_cont rather than an approximation: at this
volume there is no reason to sample. Every rate returns 0 rather than NaN on an
empty window, which is every window on day one.

The tools panel sorts busiest first because that is what it is for - learning
which tool descriptions are failing to earn selection."
```

---

### Task 7: Recent runs, users and the map

**Files:**
- Modify: `packages/ledger/src/repo/admin.ts`, `packages/ledger/src/index.ts`
- Test: `packages/ledger/src/repo/admin.test.ts` (extend)

**Interfaces:**
- Produces:

```ts
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

export interface MapPoint {
  country: string | null
  region: string | null
  city: string | null
  lat: number
  lon: number
  runs: number
}

export function recentRuns(session: AdminSession, limit?: number): Promise<AdminRun[]>
export function usersPanel(session: AdminSession, limit?: number): Promise<AdminUser[]>
export function mapPanel(session: AdminSession): Promise<MapPoint[]>
```

**Cost per user is how abuse becomes visible**, which is the reason the Users panel exists at all rather than being a list of email addresses.

**The map returns only located runs.** A run with no location is not a point at (0, 0) — that is in the Gulf of Guinea, and a dashboard that puts every local development turn there is worse than one that omits them.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/ledger/src/repo/admin.test.ts
import { mapPanel, recentRuns, usersPanel } from './admin'

describe('recentRuns', () => {
  it('shows who each run belonged to, which the scoped view cannot', async () => {
    const runs = await recentRuns(session(), 100)
    const owners = new Set(runs.map((run) => run.ownerId))
    // More than one owner is the entire point: /runs is scoped to the viewer.
    expect(owners.size).toBeGreaterThan(1)
    expect(runs[0]!.startedAt.getTime()).toBeGreaterThanOrEqual(runs.at(-1)!.startedAt.getTime())
  })
})

describe('usersPanel', () => {
  it('attributes cost and today’s messages to each visitor', async () => {
    const users = await usersPanel(session(), 100)
    const row = users.find((entry) => entry.id === alice)
    expect(row?.messagesToday).toBe(2)
    expect(row?.costUsdToDate).toBeCloseTo(0.08, 6)
    expect(row?.blockedAt).toBeNull()
  })

  it('shows a visitor who has never run a turn, with zeroes', async () => {
    // resetOwners creates the principal without any runs. Someone who signed
    // up and never spoke is exactly who you want to see on this panel.
    const users = await usersPanel(session(), 500)
    expect(users.every((entry) => Number.isFinite(entry.costUsdToDate))).toBe(true)
  })
})

describe('mapPanel', () => {
  it('groups located runs into points and drops unlocated ones', async () => {
    await adminDb().insert(traceRuns).values([
      {
        ownerId: alice,
        provider: 'test',
        model: 'test',
        channel: 'web',
        geoCountry: 'IN',
        geoCity: 'Bengaluru',
        geoLat: 12.9716,
        geoLon: 77.5946,
      },
      {
        ownerId: alice,
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
      { ownerId: alice, provider: 'test', model: 'test', channel: 'cli' },
    ])

    const points = await mapPanel(session())
    const bengaluru = points.find((point) => point.city === 'Bengaluru')
    expect(bengaluru?.runs).toBe(2)
    expect(points.every((point) => point.lat !== 0 || point.lon !== 0)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ledger/src/repo/admin.test.ts -t mapPanel`
Expected: FAIL — `mapPanel is not exported`.

- [ ] **Step 3: Implement the three**

```ts
// packages/ledger/src/repo/admin.ts
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
    // them through the cascade — but a run whose owner vanished mid-query
    // should still appear rather than disappearing from the audit trail.
    .leftJoin(user, eq(user.id, traceRuns.ownerId))
    .orderBy(desc(traceRuns.startedAt))
    .limit(limit)

  return rows.map((row) => ({
    ...row,
    inputTokens: Number(row.inputTokens),
    cachedTokens: Number(row.cachedTokens),
    outputTokens: Number(row.outputTokens),
    costUsdEst: Number(row.costUsdEst),
    ownerIsAnonymous: row.ownerIsAnonymous === true,
  }))
}

export async function usersPanel(_session: AdminSession, limit = 200): Promise<AdminUser[]> {
  // One left join and one group, rather than a query per user. Cost per user is
  // how abuse becomes visible, so it is the column that has to be right.
  const rows = await unscoped()
    .select({
      id: user.id,
      email: user.email,
      isAnonymous: user.isAnonymous,
      createdAt: user.createdAt,
      blockedAt: user.blockedAt,
      lastSeenAt: sql<Date | null>`max(${traceRuns.startedAt})`,
      messagesToday: sql<string>`count(${traceRuns.id}) filter (where ${traceRuns.startedAt} >= current_date)`,
      costUsdToDate: sql<string>`coalesce(sum(${traceRuns.costUsdEst}), 0)`,
    })
    .from(user)
    .leftJoin(traceRuns, eq(traceRuns.ownerId, user.id))
    .groupBy(user.id)
    .orderBy(desc(sql`max(${traceRuns.startedAt})`))
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
    // Only located runs. A run with no coordinates is not a point at (0, 0) —
    // that is open ocean off West Africa, and a map that puts every local
    // development turn there is worse than one that omits them.
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
```

Add `desc` to the `drizzle-orm` import.

- [ ] **Step 4: Run tests, then export the whole surface**

```bash
npx vitest run packages/ledger/src/repo/admin.test.ts
```

In `packages/ledger/src/index.ts`:

```ts
export {
  type AdminRun,
  type AdminSession,
  type AdminUser,
  assertAdmin,
  type BudgetPanel,
  budgetPanel,
  type HealthPanel,
  healthPanel,
  type MapPoint,
  mapPanel,
  recentRuns,
  type SafetyPanel,
  safetyPanel,
  type ToolStat,
  toolsPanel,
  type TrafficPanel,
  trafficPanel,
  usersPanel,
} from './repo/admin'
export { isLiveChatPaused, type OperatorFlag, setFlag } from './repo/flags'
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add the recent-runs, users and map panels

Recent runs is the existing /runs table unscoped and widened with an owner
column - which is the whole difference between a visitor's view and the
operator's. The join is a left join so a run whose owner has been reaped still
appears rather than dropping out of the audit trail.

Users is one grouped query rather than one per user, and cost per visitor is the
column that matters: it is how abuse becomes visible.

The map returns only located runs. A run with no coordinates is not a point at
(0, 0) - that is open ocean off West Africa, and a map that puts every local
development turn there is worse than one that omits them."
```

---

### Task 8: The two operator actions

**Files:**
- Modify: `packages/ledger/src/repo/admin.ts`, `packages/ledger/src/index.ts`
- Create: `apps/web/src/app/api/admin/action/route.ts`
- Test: `packages/ledger/src/repo/admin.test.ts` (extend)

**Interfaces:**
- Produces:

```ts
export function pauseLiveChat(session: AdminSession, paused: boolean): Promise<void>
export function blockOwner(session: AdminSession, ownerId: string, blocked: boolean): Promise<void>
```

**Why a read-only dashboard is not enough.** Watching an incident is not responding to one. These are the only two writes in the module, they are individually named, and each records an audit event.

**Why the audit event is a `trace_events` row.** Operator interventions appear in the same timeline as everything else rather than in a separate log nobody reads. `type` is `'error'` because the enum has no better member and adding one would be a migration for a label; the payload carries `kind: 'operator_action'`, which is what queries match on.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/ledger/src/repo/admin.test.ts
import { blockOwner, pauseLiveChat } from './admin'
import { consumeQuota } from './quota'

describe('operator actions', () => {
  afterEach(async () => {
    await pauseLiveChat(session(), false)
    await blockOwner(session(), bob, false)
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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ledger/src/repo/admin.test.ts -t "operator actions"`
Expected: FAIL — `pauseLiveChat is not exported`.

- [ ] **Step 3: Implement both, with the audit event**

```ts
// packages/ledger/src/repo/admin.ts
import { randomUUID } from 'node:crypto'
import { setFlag } from './flags'

/**
 * An operator intervention, recorded where every other event is recorded.
 *
 * It needs a run to hang off, so it makes one: a zero-cost `trace_runs` row on
 * the mcp channel owned by the target, which puts the intervention in that
 * visitor's own timeline where anyone investigating them will see it.
 *
 * `type` is 'error' because the enum has no better member, and adding one would
 * be a migration for a label. Queries match on payload kind.
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
export async function pauseLiveChat(session: AdminSession, paused: boolean): Promise<void> {
  await setFlag('live_chat_paused', paused)
  // Audited against the operator themselves: there is no visitor to attribute
  // a site-wide switch to.
  await audit(session, ADMIN_AUDIT_OWNER, 'pause_live_chat', { paused })
}

export async function blockOwner(
  session: AdminSession,
  ownerId: string,
  blocked: boolean,
): Promise<void> {
  await unscoped()
    .update(user)
    .set({ blockedAt: blocked ? new Date() : null })
    .where(eq(user.id, ownerId))
  await audit(session, ownerId, 'block_owner', { blocked })
}
```

`ADMIN_AUDIT_OWNER` is a problem worth solving deliberately rather than papering over: `trace_runs.owner_id` references `"user"(id)`, so a site-wide action has no natural owner. Resolve it by attributing site-wide actions to the operator's own user row, looked up by email:

```ts
/** The operator's own user id, so a site-wide action has an owner the FK accepts. */
async function operatorOwnerId(session: AdminSession): Promise<string | undefined> {
  const [row] = await unscoped()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, session.email))
    .limit(1)
  return row?.id
}
```

and in `pauseLiveChat`:

```ts
const owner = await operatorOwnerId(session)
// If the operator has no account yet the switch still flips; the audit entry
// is the part that is skipped, and losing it is better than refusing to pause
// during an incident.
if (owner) await audit(session, owner, 'pause_live_chat', { paused })
```

- [ ] **Step 4: Write the route**

```ts
// apps/web/src/app/api/admin/action/route.ts
import { blockOwner, pauseLiveChat } from '@kakeibo/ledger'
import { adminSession } from '@/lib/admin'

/**
 * POST /api/admin/action — the two operator writes (spec §9.4).
 *
 * 404 for anyone who is not the operator, never 403. A 403 confirms the route
 * exists, which is free reconnaissance for anyone probing a public site.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const session = await adminSession()
  if (!session) return new Response('Not found', { status: 404 })

  const body = (await request.json()) as {
    action?: 'pause_live_chat' | 'block_owner'
    paused?: boolean
    ownerId?: string
    blocked?: boolean
  }

  if (body.action === 'pause_live_chat') {
    await pauseLiveChat(session, body.paused === true)
    return Response.json({ ok: true })
  }

  if (body.action === 'block_owner' && body.ownerId) {
    await blockOwner(session, body.ownerId, body.blocked === true)
    return Response.json({ ok: true })
  }

  return Response.json({ error: 'unknown action' }, { status: 400 })
}
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run packages/ledger/src/repo/admin.test.ts
pnpm lint && pnpm typecheck && pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add the two operator actions

A read-only dashboard can watch an incident but not respond to one. These are
the only writes in the module, individually named, and each records an audit
entry.

The audit entry is a trace_events row rather than a separate log, so operator
interventions appear in the same timeline as everything else - and blocking a
visitor lands in that visitor's own timeline, where anyone investigating them
will see it. It records who, to whom and what changed; an audit entry that does
not say who is a note to nobody.

The route answers 404 rather than 403 to anyone who is not the operator. A 403
confirms the route exists, which is free reconnaissance on a public site."
```

---

### Task 9: `/admin`

**Files:**
- Create: `apps/web/src/app/admin/page.tsx`, `apps/web/src/app/admin/panels.tsx`, `apps/web/src/app/admin/world-map.tsx`, `apps/web/src/app/admin/actions.tsx`
- Modify: `apps/web/src/components/nav.tsx`

**Interfaces:**
- Consumes: every panel function from Tasks 5–7, `adminSession` from Task 4, the route from Task 8.

**Genre: terminal, matching the trace viewer.** §7 of the design keeps the monospace terminal aesthetic for `/runs` deliberately, and `/admin` matches it. The warm editorial direction is for product pages and arrives in Phase 2; this page is not one.

**About the map.** §9.5 asks for an inline SVG world map with plotted points, no tile provider and no library. This task renders an equirectangular graticule — meridians and parallels computed arithmetically — with the points plotted on it, and labels the busiest points by city. It deliberately does **not** draw coastlines: an accurate world outline is a data file, and writing one from memory would be inventing geography. If a coastline is wanted, add a vetted public-domain simplified world path to `apps/web/public/` as a deliberate asset and render it behind the graticule; that is a five-line change to this component and a decision about provenance, which is not a decision to make by guessing.

- [ ] **Step 1: Write the page**

```tsx
// apps/web/src/app/admin/page.tsx
import {
  budgetPanel,
  healthPanel,
  mapPanel,
  recentRuns,
  safetyPanel,
  toolsPanel,
  trafficPanel,
  usersPanel,
} from '@kakeibo/ledger'
import { notFound } from 'next/navigation'
import { adminSession } from '@/lib/admin'
import { OperatorActions } from './actions'
import { Budget, Health, RecentRuns, Safety, Tools, Traffic, Users } from './panels'
import { WorldMap } from './world-map'

/**
 * The operator dashboard (spec §9).
 *
 * Terminal genre, matching the trace viewer: this is not a product page and the
 * warm editorial direction in Phase 2 does not apply to it.
 *
 * Budget is first and largest because it is the number that can hurt.
 */

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const session = await adminSession()
  // 404, not 403. A 403 confirms the route exists.
  if (!session) notFound()

  const [budget, traffic, health, safety, tools, runs, users, points] = await Promise.all([
    budgetPanel(session),
    trafficPanel(session),
    healthPanel(session),
    safetyPanel(session),
    toolsPanel(session),
    recentRuns(session, 100),
    usersPanel(session, 200),
    mapPanel(session),
  ])

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg text-ink-100">Operator</h1>
          <p className="mt-1 text-xs text-ink-500">
            Every owner, unscoped. Trace payloads include ledger contents — see the privacy page.
          </p>
        </div>
        <span className="font-mono text-[11px] text-ink-500">{session.email}</span>
      </div>

      <Budget panel={budget} />
      <OperatorActions paused={budget.state === 'paused'} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Traffic panel={traffic} />
        <Health panel={health} />
        <Safety panel={safety} />
        <Tools stats={tools} />
      </div>
      <WorldMap points={points} />
      <RecentRuns runs={runs} />
      <Users users={users} />
    </div>
  )
}
```

- [ ] **Step 2: Write the panels**

`apps/web/src/app/admin/panels.tsx` exports one component per panel, all presentational, all server components, reusing `Card`, `Stat`, `Badge`, `EmptyState` and `statusTone` from `@/components/ui`. Follow `apps/web/src/app/runs/page.tsx` for table markup — same `divide-y divide-ink-800/60` rows, same `num` class on numeric cells, same `formatUsd` for money.

The one component with real logic is the sparkline, which is inline SVG and needs no library:

```tsx
function Sparkline({ points, capUsd }: { points: { day: string; usd: number }[]; capUsd: number }) {
  const max = Math.max(capUsd, ...points.map((point) => point.usd))
  const width = 320
  const height = 40
  const step = width / Math.max(1, points.length - 1)
  const path = points
    .map((point, i) => `${i === 0 ? 'M' : 'L'} ${i * step} ${height - (point.usd / max) * height}`)
    .join(' ')
  // The cap drawn as a rule, not just implied by the shape: the question this
  // chart answers is "are we near the ceiling", not "what is the trend".
  const capY = height - (capUsd / max) * height

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-10 w-full" role="img" aria-label="30-day spend">
      <line x1="0" y1={capY} x2={width} y2={capY} className="stroke-warn/40" strokeDasharray="2 3" />
      <path d={path} className="stroke-accent" fill="none" strokeWidth="1.5" />
    </svg>
  )
}
```

The Users table renders `blockedAt` as a `<Badge tone="danger">blocked</Badge>` and gives each row a block/unblock button wired to the Task 8 route.

- [ ] **Step 3: Write the map**

```tsx
// apps/web/src/app/admin/world-map.tsx
import type { MapPoint } from '@kakeibo/ledger'
import { Card, EmptyState } from '@/components/ui'

/**
 * Visitor activity on an equirectangular projection (spec §9.5).
 *
 * Inline SVG: no tile provider, no map library, no API key and no external
 * request, which keeps this page dependency-free and consistent with its genre.
 *
 * There are deliberately no coastlines. An accurate world outline is a data
 * file, and drawing one from memory would be inventing geography. If one is
 * wanted, add a vetted public-domain simplified world path as an asset and
 * render it behind the graticule.
 */
export function WorldMap({ points }: { points: MapPoint[] }) {
  if (points.length === 0) {
    // Local development resolves no addresses at all, so this is the normal
    // state before deployment rather than an error.
    return <EmptyState title="No located visits yet." hint="Locations come from the edge; there are none locally." />
  }

  const width = 720
  const height = 360
  const project = (lat: number, lon: number) => ({
    x: ((lon + 180) / 360) * width,
    y: ((90 - lat) / 180) * height,
  })
  const busiest = Math.max(...points.map((point) => point.runs))

  return (
    <Card className="overflow-hidden p-4">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Visitor map">
        <title>Approximate visitor locations, city level</title>
        {[-60, -30, 0, 30, 60].map((lat) => (
          <line key={lat} x1={0} x2={width} y1={project(lat, 0).y} y2={project(lat, 0).y}
            className={lat === 0 ? 'stroke-ink-700' : 'stroke-ink-800'} strokeWidth="0.5" />
        ))}
        {[-120, -60, 0, 60, 120].map((lon) => (
          <line key={lon} y1={0} y2={height} x1={project(0, lon).x} x2={project(0, lon).x}
            className={lon === 0 ? 'stroke-ink-700' : 'stroke-ink-800'} strokeWidth="0.5" />
        ))}
        {points.map((point) => {
          const { x, y } = project(point.lat, point.lon)
          // Area proportional to activity, so a city with four times the turns
          // looks four times as big rather than sixteen.
          const r = 2 + Math.sqrt(point.runs / busiest) * 8
          return (
            <g key={`${point.lat},${point.lon}`}>
              <circle cx={x} cy={y} r={r} className="fill-accent/25 stroke-accent" strokeWidth="0.75" />
              <title>{`${point.city ?? 'unknown'}, ${point.country ?? '??'} — ${point.runs} turn(s)`}</title>
            </g>
          )
        })}
      </svg>
    </Card>
  )
}
```

- [ ] **Step 4: Write the actions component**

`apps/web/src/app/admin/actions.tsx` is `'use client'`, renders the pause toggle, POSTs to `/api/admin/action`, and calls `router.refresh()` afterwards so the page reflects the new state without a full reload.

- [ ] **Step 5: Add the nav link, conditionally**

`Nav` is a client component and cannot read the session. Rather than making it async, pass a prop from the layout, which is a server component:

```tsx
// apps/web/src/app/layout.tsx
const isOperator = (await adminSession()) !== undefined
// ...
<Nav showAdmin={isOperator} />
```

and in `Nav`, append `{ href: '/admin', label: 'operator' }` to `LINKS` only when `showAdmin`. A link nobody else can see is not the security boundary — the 404 is — but a dead link in everyone's nav is an invitation to probe.

- [ ] **Step 6: Verify by eye and by hand**

```bash
# ADMIN_EMAILS must contain an account you can actually sign in as.
pnpm dev
# 1. Signed out or anonymous  -> /admin renders the 404 page
# 2. Signed in as a non-admin -> /admin renders the 404 page
# 3. Signed in as the admin   -> all eight panels render, empty ones included
# 4. Pause, then send a chat message -> 503 with reason "paused"
# 5. Unpause -> chat works again
# 6. Block yourself from the users table -> 503 with reason "blocked", then unblock
```

Check each of the six by hand and record what happened in the commit message. An admin page whose authorization was never exercised against a real non-admin session is an admin page with an untested lock.

- [ ] **Step 7: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @kakeibo/web build
git add -A
git commit -m "Add the operator dashboard at /admin

Eight panels in the trace viewer's genre, budget first and largest because it is
the number that can hurt. Everything is derived from trace_runs, trace_events
and the user table; no new instrumentation and deliberately no rollup tables -
at this volume a direct scan stays fast for years and a rollup is a cache to
invalidate for no present gain.

A non-admin gets the 404 page, not a 403: a 403 confirms the route exists. The
nav link is hidden rather than relied on - the 404 is the boundary, but a dead
link in everyone's nav is an invitation to probe.

The map is inline SVG on an equirectangular projection with no tiles, no library
and no external request. It draws a graticule and the points, and deliberately
no coastlines: an accurate world outline is a data file, and drawing one from
memory would be inventing geography."
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/kakeibo_spec.md`, `README.md`, `CLAUDE.md`, `docs/continue-here.md`

- [ ] **Step 1: Amend the spec**

`docs/kakeibo_spec.md` §7 gains `operator_flags` and the five `geo_*` columns; §16 gains `ADMIN_EMAILS` and `ALLOW_DESTRUCTIVE_RESET`; a new §9.7 records the correction to §11's containment test and why the literal version was unsatisfiable.

- [ ] **Step 2: Amend the README**

One new section, kept short, on the one-door rule: what `admin.ts` is, why `AdminSession` is unforgeable, and what the containment test actually asserts. No new numbers unless `pnpm metrics` prints them.

- [ ] **Step 3: Amend CLAUDE.md**

One rule: cross-owner reads live in `packages/ledger/src/repo/admin.ts` and take an `AdminSession`; adding a module to the containment allowlist is a deliberate act, and the first question is whether the query could be owner-scoped instead.

- [ ] **Step 4: Rewrite the handoff**

`docs/continue-here.md` for Plan D: what is done, what remains, and the findings from this plan that cost time.

- [ ] **Step 5: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add -A
git commit -m "Document the operator dashboard and the one-door rule"
```

---

## Why this plan stops where it does

The design spec's remaining scope splits cleanly in two, and the split is not arbitrary.

**This plan** is everything in the operator's genre: the dashboard is explicitly "terminal — matches the trace viewer" (§7), so it can be built now against the aesthetic that already exists, and none of it waits on anything.

**Plan D — the public surface and the deploy** is the rest, and every part of it either waits on Phase 2's visual direction or on an account only the owner can create:

- the sign-in, sign-up and `/settings` pages, `/privacy` and `/terms` — all "warm editorial" product pages, which Phase 2 defines and which would otherwise be built twice;
- Turnstile on the anonymous entry point — needs a Cloudflare site key;
- Vercel and Neon — needs both accounts, plus Google OAuth credentials for the deployed origin.

Building the product pages before Phase 2 sets the direction means restyling them immediately afterwards. Building the deploy before the owner has the accounts means guessing.

## Self-Review

**Spec coverage.** §3.5 geolocation columns → Task 1. §5 layer 4 Turnstile → Plan D. §9.1 authorization → Task 4. §9.2 one door → Task 4, containment test. §9.3 panels 1–8 → Tasks 5, 6, 7, 9. §9.4 operator actions → Tasks 3 and 8. §9.5 map → Tasks 1 and 9. §9.6 privacy consequence → stated on the page in Task 9, and the privacy page itself is Plan D. §10 deploy → Plan D, except the `resetAndSeed` guard, which is Task 2 because it protects against a mistake that becomes possible the moment a production database exists. §11 test rows for admin authorization, containment, operator actions and the visitor map → Tasks 1, 4, 8.

**Placeholder scan.** Task 9 Steps 2 and 4 describe components rather than giving their full source, which is a deliberate exception and the only one: they are presentational JSX over an existing component library, the two pieces with actual logic (the sparkline and the map) are given in full, and the existing `runs/page.tsx` is a complete worked example of the table markup to copy. Everything else in the plan is executable as written.

**Type consistency.** `AdminSession` is the first parameter of every function in `admin.ts`, in Tasks 4–8. `RunGeo` has the same five optional fields in `trace.ts`, `geo.ts` and the tracer. `QuotaReason` gains exactly one member, `'paused'`, in Task 3, and `quotaRefusal` gains exactly one message for it. `setFlag`/`isFlagSet` in `flags.ts` are the only writers of `operator_flags`, and `pauseLiveChat` in Task 8 calls `setFlag` rather than reimplementing it.

**The risk worth naming.** Task 4 creates a module that can read every visitor's data, and Tasks 5–8 fill it. If the containment test is ever "fixed" by adding a module to the allowlist without asking whether the query could be owner-scoped instead, the test stops being a boundary and becomes a formality. The allowlist carries a reason per entry so that a reviewer can see when one is missing.
