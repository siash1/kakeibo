# Multi-Tenancy Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every ledger row belong to an owner, scope every repository query to that owner, and have Postgres refuse to serve rows the current owner does not own — without changing any user-visible behaviour.

**Architecture:** An `owner_id` column on all nine data tables, threaded as the first parameter of every repository function (application layer), backed by Postgres row-level security keyed on a transaction-local setting (database layer). The repository stays the single access path it already is for the double-entry invariant. A forgotten `where` clause returns zero rows instead of another owner's ledger.

**Tech Stack:** TypeScript (strict), Drizzle ORM 0.44, PostgreSQL, node-postgres, Vitest.

This plan is Plan A of three. It deliberately does **not** add authentication — `owner_id` is supplied by callers, and a single fixed development owner keeps the CLI, MCP server and eval harness working exactly as they do today. Plan B adds Better Auth and replaces that fixed owner with a real session.

## Global Constraints

Copied verbatim from `CLAUDE.md` and the spec; every task's requirements include these.

- **No AI co-author trailers in commits.** No `Co-Authored-By: Claude`, no "Generated with" footers. Author is the repository owner.
- **TypeScript strict everywhere.** `any` only at the provider wire boundary, with a comment.
- **Money is integer minor units** (paise). Never floats outside display.
- **Secrets never in git.** `.env` is gitignored; `.env.example` carries empty values only.
- **No agent frameworks in core.** `@google/genai` is a typed HTTP client only.
- **The repository layer is the single insert path.** The double-entry invariant lives there, not in a trigger.
- `pnpm lint && pnpm typecheck && pnpm test` must pass before every commit.
- Tests run against recorded fixtures and need no API key.
- Better Auth's principal table is named `user`, a reserved word in Postgres: **always quote it** as `"user"` in hand-written SQL.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/ledger/src/owner.ts` | **Create.** The `OwnerId` branded type, the fixed development owner constant, and `withOwner()`. |
| `packages/ledger/src/schema.ts` | **Modify.** Add `ownerId` to nine tables; change the `accounts` unique constraint. |
| `packages/ledger/src/db.ts` | **Modify.** Add the RLS-aware transaction helper and the privileged connection used by migrations. |
| `packages/ledger/src/repo/*.ts` | **Modify.** Add `owner` as the first parameter of every query function. |
| `packages/ledger/drizzle/*.sql` | **Generate + hand-edit.** Column migration, then a hand-written RLS policy migration. |
| `packages/ledger/src/isolation.test.ts` | **Create.** Two owners; proves neither can see the other. |
| `packages/ledger/src/rls.test.ts` | **Create.** Proves the database refuses unscoped reads. |

`owner.ts` is deliberately its own file rather than part of `db.ts`: it is imported by every repository module and by Plan B's auth layer, and a type that everything depends on should not drag a database connection with it.

---

### Task 1: The owner type and the development owner

**Files:**
- Create: `packages/ledger/src/owner.ts`
- Test: `packages/ledger/src/owner.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type OwnerId = string & { readonly __owner: unique symbol }`
  - `function asOwnerId(value: string): OwnerId`
  - `const DEV_OWNER_ID: OwnerId` — the fixed UUID every local tool uses until Plan B.

A branded type is the point of this task. `ownerId: string` next to `accountId: string` and `transactionId: string` is three interchangeable strings, and passing the wrong one compiles fine. Branding makes that a type error, which matters when 24 functions are about to gain the parameter.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ledger/src/owner.test.ts
import { describe, expect, it } from 'vitest'
import { asOwnerId, DEV_OWNER_ID } from './owner'

describe('OwnerId', () => {
  it('accepts a uuid', () => {
    expect(asOwnerId('3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8')).toBe(
      '3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8',
    )
  })

  it('rejects anything that is not a uuid, because it reaches SQL', () => {
    expect(() => asOwnerId('not-a-uuid')).toThrow(/uuid/i)
    expect(() => asOwnerId('')).toThrow(/uuid/i)
  })

  it('exposes a stable development owner', () => {
    expect(DEV_OWNER_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(DEV_OWNER_ID).toBe(asOwnerId(DEV_OWNER_ID))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/ledger/src/owner.test.ts`
Expected: FAIL — `Cannot find module './owner'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/ledger/src/owner.ts

/**
 * Who a row belongs to.
 *
 * Branded rather than a bare string on purpose. This value is about to become
 * the first parameter of roughly two dozen repository functions that already
 * take accountId, transactionId and month as strings — and `f(accountId,
 * ownerId)` instead of `f(ownerId, accountId)` compiles perfectly happily if
 * they are all just strings. Branding turns that into a type error at the call
 * site, which is the only place it is cheap to catch.
 */
export type OwnerId = string & { readonly __owner: unique symbol }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function asOwnerId(value: string): OwnerId {
  if (!UUID.test(value)) {
    throw new Error(`Invalid OwnerId: ${JSON.stringify(value)} is not a UUID`)
  }
  return value as OwnerId
}

/**
 * The owner every local surface uses until Plan B introduces real sessions:
 * the CLI, the MCP server, `pnpm db:seed` and the eval harness.
 *
 * A fixed constant rather than a generated one so that a reseed does not orphan
 * the previous run's data, and so eval `sql_equals` oracles stay stable.
 */
export const DEV_OWNER_ID: OwnerId = asOwnerId('00000000-0000-4000-8000-000000000001')
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/ledger/src/owner.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ledger/src/owner.ts packages/ledger/src/owner.test.ts
git commit -m "Add branded OwnerId type and the fixed development owner

Branded rather than a bare string because owner_id is about to become the
first parameter of ~24 repository functions that already take several other
string ids. If they are all strings, transposing two arguments compiles."
```

---

### Task 2: Schema — owner column and the uniqueness fix

**Files:**
- Modify: `packages/ledger/src/schema.ts`
- Generate: `packages/ledger/drizzle/0001_*.sql`

**Interfaces:**
- Consumes: `OwnerId` from Task 1.
- Produces: `ownerId` column on `accounts`, `transactions`, `postings`, `rules`, `budgets`, `memories`, `importBatches`, `traceRuns`, `traceEvents`; `accountsOwnerNameKey` unique constraint.

There is no `"user"` table yet — Plan B creates it. So `owner_id` is a plain `uuid not null` here with **no foreign key**, and Plan B adds the FK once the table exists. Adding a column that references a non-existent table is not possible, and inventing a placeholder table now means a migration to drop it later.

- [ ] **Step 1: Add the column to every data table**

In `packages/ledger/src/schema.ts`, add this import and shared column near the top:

```ts
/**
 * Owner of the row.
 *
 * No foreign key yet: the principal table arrives with Better Auth in Plan B,
 * and a column cannot reference a table that does not exist. Plan B adds
 * `references "user"(id) on delete cascade` in its own migration.
 */
const ownerId = () => uuid('owner_id').notNull()
```

Add `ownerId: ownerId(),` as the second field (immediately after `id`) of: `accounts`, `transactions`, `postings`, `rules`, `budgets`, `memories`, `importBatches`, `traceRuns`, `traceEvents`.

- [ ] **Step 2: Fix the accounts uniqueness constraint**

This is the change that would otherwise surface as a production bug on the second visitor. Replace the `name` column definition and add a table-level constraint:

```ts
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    // NOT globally unique any more: every owner has their own "Groceries".
    name: text('name').notNull(),
    type: accountTypeEnum('type').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('accounts_owner_name_key').on(table.ownerId, table.name)],
)
```

- [ ] **Step 3: Make owner the leading column of every index**

Every query now filters on owner first, so the existing indexes are the wrong shape. Replace them:

```ts
// transactions
(table) => [index('transactions_owner_date_idx').on(table.ownerId, table.date)],

// postings
(table) => [
  index('postings_owner_transaction_idx').on(table.ownerId, table.transactionId),
  index('postings_owner_account_idx').on(table.ownerId, table.accountId),
],

// traceRuns
(table) => [index('trace_runs_owner_started_idx').on(table.ownerId, table.startedAt)],

// traceEvents
(table) => [index('trace_events_owner_run_idx').on(table.ownerId, table.runId, table.seq)],
```

- [ ] **Step 4: Generate the migration**

Run: `cd packages/ledger && npx drizzle-kit generate`
Expected: a new file `packages/ledger/drizzle/0001_*.sql` containing `ALTER TABLE ... ADD COLUMN "owner_id" uuid NOT NULL`, the dropped `accounts_name_unique`, the new `accounts_owner_name_key`, and the index changes.

- [ ] **Step 5: Make the migration safe on a non-empty database**

`ADD COLUMN ... NOT NULL` fails if rows exist. Open the generated SQL and, **above** every `ADD COLUMN` statement, there must be a default to backfill with. Hand-edit each one to the two-step form:

```sql
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "owner_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;
--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "owner_id" DROP DEFAULT;
```

Repeat for all nine tables. The default backfills existing local rows to the development owner and is then dropped, so future inserts must supply an owner explicitly rather than silently landing in the dev tenant.

- [ ] **Step 6: Apply the migration and verify**

```bash
cd /Users/ashish/Desktop/kakeibo
pnpm db:migrate
PGPASSWORD=kakeibo psql -h localhost -p 5433 -U kakeibo -d kakeibo -tA -c \
  "select count(*) from information_schema.columns where column_name='owner_id'"
```

Expected: `9`.

```bash
PGPASSWORD=kakeibo psql -h localhost -p 5433 -U kakeibo -d kakeibo -tA -c \
  "select conname from pg_constraint where conname in ('accounts_name_unique','accounts_owner_name_key')"
```

Expected: `accounts_owner_name_key` only.

- [ ] **Step 7: Commit**

```bash
git add packages/ledger/src/schema.ts packages/ledger/drizzle
git commit -m "Add owner_id to every data table; scope accounts.name per owner

accounts.name was globally unique, so the second owner to exist could not
have a Groceries account and seeding their ledger would fail. It is now
unique(owner_id, name).

owner_id carries no foreign key yet because the principal table arrives with
Better Auth in Plan B. The migration backfills existing rows to the fixed
development owner via a temporary default, then drops the default so future
inserts must be explicit."
```

---

### Task 3: `withOwner` — the RLS-aware transaction helper

**Files:**
- Modify: `packages/ledger/src/db.ts`
- Test: `packages/ledger/src/db.test.ts`

**Interfaces:**
- Consumes: `OwnerId` from Task 1.
- Produces:
  - `function withOwner<T>(owner: OwnerId, fn: (tx: Tx) => Promise<T>): Promise<T>`
  - `type Tx` — the Drizzle transaction handle repository functions receive.
  - `function adminDb(): Db` — the unscoped connection, for migrations, seeding and Plan C's admin module.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ledger/src/db.test.ts
import { loadEnv } from '@kakeibo/core/env'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, withOwner } from './db'
import { asOwnerId, DEV_OWNER_ID } from './owner'

loadEnv()

afterAll(async () => {
  await closeDb()
})

describe('withOwner', () => {
  it('sets app.owner_id for the duration of the transaction', async () => {
    const seen = await withOwner(DEV_OWNER_ID, async (tx) => {
      const result = await tx.execute(sql`select current_setting('app.owner_id', true) as owner`)
      return (result.rows as { owner: string }[])[0]?.owner
    })
    expect(seen).toBe(DEV_OWNER_ID)
  })

  it('does not leak the setting to the next transaction on a pooled connection', async () => {
    const other = asOwnerId('00000000-0000-4000-8000-0000000000ff')
    await withOwner(other, async (tx) => {
      await tx.execute(sql`select 1`)
    })

    // A fresh transaction that sets nothing must not inherit `other`.
    // SET LOCAL is transaction-scoped; plain SET would survive here and hand
    // the next request the previous request's tenant.
    const leaked = await withOwner(DEV_OWNER_ID, async (tx) => {
      const result = await tx.execute(sql`select current_setting('app.owner_id', true) as owner`)
      return (result.rows as { owner: string }[])[0]?.owner
    })
    expect(leaked).toBe(DEV_OWNER_ID)
  })

  it('rolls back on error so a failed turn writes nothing', async () => {
    await expect(
      withOwner(DEV_OWNER_ID, async (tx) => {
        await tx.execute(sql`create temporary table should_not_survive (x int)`)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/ledger/src/db.test.ts`
Expected: FAIL — `withOwner is not exported`.

- [ ] **Step 3: Write the implementation**

Add to `packages/ledger/src/db.ts`:

```ts
import { sql } from 'drizzle-orm'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import type { OwnerId } from './owner'

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Runs `fn` inside a transaction with `app.owner_id` set, which is what the
 * row-level security policies read.
 *
 * `SET LOCAL`, not `SET`. LOCAL is scoped to the transaction, so when the
 * pooler hands this connection to the next request the setting is already
 * gone. Plain `SET` persists for the life of the connection and would let one
 * request inherit the previous request's tenant — which behind a pooler is a
 * cross-tenant data leak that appears only under concurrency, i.e. in
 * production and never in a test.
 */
export async function withOwner<T>(owner: OwnerId, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    // set_config's third argument is `is_local`; true makes it SET LOCAL.
    // Parameterised rather than interpolated: owner reaches SQL directly.
    await tx.execute(sql`select set_config('app.owner_id', ${owner}, true)`)
    return fn(tx)
  })
}

/**
 * The unscoped connection. Used by migrations, `pnpm db:seed`, the eval
 * harness, and — in Plan C — the admin module, which is the only part of the
 * application allowed to touch it.
 */
export function adminDb(): Db {
  return getDb()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/ledger/src/db.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ledger/src/db.ts packages/ledger/src/db.test.ts
git commit -m "Add withOwner: transaction-scoped tenant setting for RLS

Uses SET LOCAL via set_config(..., true) rather than SET. LOCAL dies with the
transaction, so a pooled connection handed to the next request cannot inherit
the previous request's tenant. Plain SET would produce a cross-tenant leak
visible only under concurrency."
```

---

### Task 4: Scope the accounts repository

**Files:**
- Modify: `packages/ledger/src/repo/accounts.ts`
- Test: `packages/ledger/src/repo/accounts.test.ts`

**Interfaces:**
- Consumes: `OwnerId`, `withOwner`.
- Produces (every signature gains `owner` first):
  - `listAccounts(owner: OwnerId): Promise<Account[]>`
  - `accountByName(owner: OwnerId, name: string): Promise<Account | undefined>`
  - `requireAccount(owner: OwnerId, name: string): Promise<Account>`
  - `accountsByIds(owner: OwnerId, ids: string[]): Promise<Map<string, Account>>`
  - `accountBalances(owner: OwnerId): Promise<AccountBalance[]>`
  - `ensureSeedAccounts(owner: OwnerId): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/ledger/src/repo/accounts.test.ts
import { loadEnv } from '@kakeibo/core/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../db'
import { asOwnerId } from '../owner'
import { accountByName, ensureSeedAccounts, listAccounts } from './accounts'

loadEnv()

const alice = asOwnerId('00000000-0000-4000-8000-00000000a11c')
const bob = asOwnerId('00000000-0000-4000-8000-00000000b0b0')

beforeAll(async () => {
  await ensureSeedAccounts(alice)
  await ensureSeedAccounts(bob)
}, 60_000)

afterAll(async () => {
  await closeDb()
})

describe('accounts are owner-scoped', () => {
  it('gives each owner their own chart of accounts', async () => {
    const aliceAccounts = await listAccounts(alice)
    const bobAccounts = await listAccounts(bob)

    expect(aliceAccounts.length).toBeGreaterThan(0)
    expect(aliceAccounts).toHaveLength(bobAccounts.length)
    // Same names, different rows. This is the case the old global unique
    // constraint on accounts.name made impossible.
    expect(aliceAccounts.map((a) => a.name).sort()).toEqual(bobAccounts.map((a) => a.name).sort())
    const aliceIds = new Set(aliceAccounts.map((a) => a.id))
    expect(bobAccounts.every((b) => !aliceIds.has(b.id))).toBe(true)
  })

  it('resolves a name to the asking owner\'s account', async () => {
    const aliceGroceries = await accountByName(alice, 'Groceries')
    const bobGroceries = await accountByName(bob, 'Groceries')

    expect(aliceGroceries).toBeDefined()
    expect(bobGroceries).toBeDefined()
    expect(aliceGroceries?.id).not.toBe(bobGroceries?.id)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/ledger/src/repo/accounts.test.ts`
Expected: FAIL — `Expected 1 arguments, but got 2` (typecheck) or a runtime error from `ensureSeedAccounts`.

- [ ] **Step 3: Rewrite the module**

```ts
// packages/ledger/src/repo/accounts.ts
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { normalizeCategory, SEED_ACCOUNTS } from '../categories'
import { withOwner } from '../db'
import type { OwnerId } from '../owner'
import { type Account, accounts, postings } from '../schema'

export async function listAccounts(owner: OwnerId): Promise<Account[]> {
  return withOwner(owner, (tx) =>
    tx
      .select()
      .from(accounts)
      .where(eq(accounts.ownerId, owner))
      .orderBy(asc(accounts.type), asc(accounts.name)),
  )
}

export async function accountByName(owner: OwnerId, name: string): Promise<Account | undefined> {
  const canonical = normalizeCategory(name) ?? name
  const rows = await withOwner(owner, (tx) =>
    tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.ownerId, owner), eq(accounts.name, canonical)))
      .limit(1),
  )
  return rows[0]
}

export async function requireAccount(owner: OwnerId, name: string): Promise<Account> {
  const account = await accountByName(owner, name)
  if (account) return account
  const known = (await listAccounts(owner)).map((a) => a.name).join(', ')
  throw new Error(`No account named "${name}". Known accounts: ${known}`)
}

export async function accountsByIds(
  owner: OwnerId,
  ids: string[],
): Promise<Map<string, Account>> {
  if (ids.length === 0) return new Map()
  const rows = await withOwner(owner, (tx) =>
    tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.ownerId, owner), inArray(accounts.id, ids))),
  )
  return new Map(rows.map((row) => [row.id, row]))
}

export interface AccountBalance extends Account {
  balanceMinor: number
  postingCount: number
}

export async function accountBalances(owner: OwnerId): Promise<AccountBalance[]> {
  const rows = await withOwner(owner, (tx) =>
    tx
      .select({
        id: accounts.id,
        ownerId: accounts.ownerId,
        name: accounts.name,
        type: accounts.type,
        currency: accounts.currency,
        createdAt: accounts.createdAt,
        balanceMinor: sql<number>`coalesce(sum(${postings.amountMinor}), 0)::bigint`,
        postingCount: sql<number>`count(${postings.id})::int`,
      })
      .from(accounts)
      // The join is owner-scoped too. Joining on account_id alone would be
      // correct only because account ids are unique — relying on that makes
      // the isolation accidental rather than stated.
      .leftJoin(postings, and(eq(postings.accountId, accounts.id), eq(postings.ownerId, owner)))
      .where(eq(accounts.ownerId, owner))
      .groupBy(accounts.id)
      .orderBy(asc(accounts.type), asc(accounts.name)),
  )

  return rows.map((row) => ({
    ...row,
    balanceMinor: Number(row.balanceMinor),
    postingCount: Number(row.postingCount),
  }))
}

/** Idempotent: seeding twice must not duplicate an owner's chart of accounts. */
export async function ensureSeedAccounts(owner: OwnerId): Promise<void> {
  await withOwner(owner, (tx) =>
    tx
      .insert(accounts)
      .values(SEED_ACCOUNTS.map((a) => ({ ownerId: owner, name: a.name, type: a.type })))
      .onConflictDoNothing({ target: [accounts.ownerId, accounts.name] }),
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/ledger/src/repo/accounts.test.ts`
Expected: PASS, 2 tests. Other suites will not compile yet — that is expected and Tasks 5–8 fix them.

- [ ] **Step 5: Commit**

```bash
git add packages/ledger/src/repo/accounts.ts packages/ledger/src/repo/accounts.test.ts
git commit -m "Scope the accounts repository to an owner

Every query filters on owner_id and runs inside withOwner. The balances join
is owner-scoped on both sides: joining on account_id alone would be correct
only because ids happen to be unique, which makes isolation accidental."
```

---

### Task 5: Scope the transactions repository

**Files:**
- Modify: `packages/ledger/src/repo/transactions.ts`
- Test: `packages/ledger/src/repo/transactions.test.ts`

**Interfaces:**
- Produces:
  - `createTransaction(owner: OwnerId, input: CreateTransactionInput): Promise<Transaction>`
  - `createTransactions(owner: OwnerId, inputs: CreateTransactionInput[]): Promise<number>`
  - `searchTransactions(owner: OwnerId, filters: SearchFilters): Promise<TransactionWithPostings[]>`
  - `transactionsByIds(owner: OwnerId, ids: string[]): Promise<TransactionWithPostings[]>`
  - `categorizeTransactions(owner: OwnerId, transactionIds: string[], categoryName: string): Promise<CategorizeResult>`
  - `findUnbalancedTransactions(owner: OwnerId): Promise<{ id: string; delta: number }[]>`
  - `assertBalanced(inputs: PostingInput[]): void` — **unchanged**, it is pure and owner-free.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ledger/src/repo/transactions.test.ts
import { loadEnv } from '@kakeibo/core/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../db'
import { asOwnerId } from '../owner'
import { ensureSeedAccounts, requireAccount } from './accounts'
import {
  categorizeTransactions,
  createTransaction,
  findUnbalancedTransactions,
  searchTransactions,
  transactionsByIds,
} from './transactions'

loadEnv()

const alice = asOwnerId('00000000-0000-4000-8000-00000000a22c')
const bob = asOwnerId('00000000-0000-4000-8000-00000000b22b')

async function spend(owner: ReturnType<typeof asOwnerId>, description: string, minor: number) {
  const checking = await requireAccount(owner, 'Checking')
  const groceries = await requireAccount(owner, 'Groceries')
  return createTransaction(owner, {
    date: '2025-03-15',
    description,
    postings: [
      { accountId: checking.id, amountMinor: -minor },
      { accountId: groceries.id, amountMinor: minor },
    ],
  })
}

beforeAll(async () => {
  await ensureSeedAccounts(alice)
  await ensureSeedAccounts(bob)
  await spend(alice, 'ALICE SECRET SHOP', 12345)
  await spend(bob, 'BOB SECRET SHOP', 54321)
}, 60_000)

afterAll(async () => {
  await closeDb()
})

describe('transactions are owner-scoped', () => {
  it('never returns another owner\'s transactions from a search', async () => {
    const aliceRows = await searchTransactions(alice, { query: 'SECRET SHOP', limit: 50 })
    expect(aliceRows.map((r) => r.description)).toEqual(['ALICE SECRET SHOP'])

    const bobRows = await searchTransactions(bob, { query: 'SECRET SHOP', limit: 50 })
    expect(bobRows.map((r) => r.description)).toEqual(['BOB SECRET SHOP'])
  })

  it('will not fetch another owner\'s transaction even by exact id', async () => {
    const [bobRow] = await searchTransactions(bob, { query: 'BOB SECRET', limit: 1 })
    expect(bobRow).toBeDefined()

    // Guessing an id must not be enough. This is the attack the whole plan
    // exists to stop.
    const stolen = await transactionsByIds(alice, [bobRow!.id])
    expect(stolen).toEqual([])
  })

  it('will not categorise another owner\'s transaction', async () => {
    const [bobRow] = await searchTransactions(bob, { query: 'BOB SECRET', limit: 1 })
    const result = await categorizeTransactions(alice, [bobRow!.id], 'Dining')

    expect(result.updated).toBe(0)
    expect(result.skipped[0]?.reason).toMatch(/no such transaction/i)
  })

  it('keeps the double-entry invariant per owner', async () => {
    expect(await findUnbalancedTransactions(alice)).toEqual([])
    expect(await findUnbalancedTransactions(bob)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/ledger/src/repo/transactions.test.ts`
Expected: FAIL — argument-count type errors.

- [ ] **Step 3: Rewrite the module**

Apply these mechanical changes throughout `packages/ledger/src/repo/transactions.ts`:

1. Import `withOwner` from `../db` and `type OwnerId` from `../owner`.
2. Add `owner: OwnerId` as the first parameter of the six functions listed under **Interfaces** above.
3. Replace every `getDb().transaction(async (tx) => {...})` with `withOwner(owner, async (tx) => {...})`, and every bare `getDb()` with `withOwner(owner, (tx) => ...)`.
4. Stamp `ownerId: owner` onto every `.values({...})` for both `transactions` and `postings`.
5. Add `eq(transactions.ownerId, owner)` / `eq(postings.ownerId, owner)` to every `where`.

The two that need care rather than mechanism:

```ts
// searchTransactions — owner is the FIRST condition, so a scan is bounded by
// tenant before any of the user's filters apply.
const conditions = [eq(transactions.ownerId, owner)]
if (filters.query) { /* ...unchanged... */ }

// ...and the correlated subqueries must be owner-scoped too, or an amount
// filter could confirm the existence of another owner's posting.
if (filters.minMinor !== undefined) {
  conditions.push(
    sql`exists (select 1 from ${postings} p where p.transaction_id = ${transactions.id}
        and p.owner_id = ${owner} and abs(p.amount_minor) >= ${filters.minMinor})`,
  )
}
```

```ts
// hydratePostings takes the owner explicitly rather than inferring it from the
// rows it was handed — inferring would trust its caller to have scoped already.
async function hydratePostings(
  owner: OwnerId,
  rows: Transaction[],
): Promise<TransactionWithPostings[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const postingRows = await withOwner(owner, (tx) =>
    tx
      .select({ /* ...unchanged... */ })
      .from(postings)
      .innerJoin(accounts, and(eq(accounts.id, postings.accountId), eq(accounts.ownerId, owner)))
      .where(and(eq(postings.ownerId, owner), inArray(postings.transactionId, ids))),
  )
  // ...rest unchanged
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/ledger/src/repo/transactions.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ledger/src/repo/transactions.ts packages/ledger/src/repo/transactions.test.ts
git commit -m "Scope the transactions repository to an owner

Owner is the first condition of every where clause, including the correlated
subqueries behind the amount filters - an unscoped exists() there would let
one owner confirm the existence of another's posting by binary search on
amount. Fetching by exact id across owners now returns nothing."
```

---

### Task 6: Scope the reports repository

**Files:**
- Modify: `packages/ledger/src/repo/reports.ts`
- Test: `packages/ledger/src/repo/reports.test.ts`

**Interfaces:**
- Produces:
  - `spendReport(owner: OwnerId, period: Period, groupBy: 'category' | 'month', options?): Promise<SpendGroup[]>`
  - `budgetStatus(owner: OwnerId, month: string): Promise<BudgetStatusRow[]>`
  - `detectRecurring(owner: OwnerId, minOccurrences?: number): Promise<RecurringMerchant[]>`
  - `flagAnomalies(owner: OwnerId, month: string): Promise<Anomaly[]>`
  - `monthToPeriod`, `shiftMonth`, `merchantKey` — **unchanged**, pure functions.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ledger/src/repo/reports.test.ts
import { loadEnv } from '@kakeibo/core/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../db'
import { asOwnerId } from '../owner'
import { ensureSeedAccounts, requireAccount } from './accounts'
import { monthToPeriod, spendReport } from './reports'
import { createTransaction } from './transactions'

loadEnv()

const rich = asOwnerId('00000000-0000-4000-8000-00000000c111')
const poor = asOwnerId('00000000-0000-4000-8000-00000000c222')

beforeAll(async () => {
  for (const [owner, minor] of [[rich, 1_000_000], [poor, 1_000]] as const) {
    await ensureSeedAccounts(owner)
    const checking = await requireAccount(owner, 'Checking')
    const groceries = await requireAccount(owner, 'Groceries')
    await createTransaction(owner, {
      date: '2025-03-10',
      description: 'SHOP',
      postings: [
        { accountId: checking.id, amountMinor: -minor },
        { accountId: groceries.id, amountMinor: minor },
      ],
    })
  }
}, 60_000)

afterAll(async () => {
  await closeDb()
})

describe('reports are owner-scoped', () => {
  it('does not add another owner\'s spending into the total', async () => {
    const richReport = await spendReport(rich, monthToPeriod('2025-03'), 'category')
    const poorReport = await spendReport(poor, monthToPeriod('2025-03'), 'category')

    expect(richReport.find((g) => g.group === 'Groceries')?.totalMinor).toBe(1_000_000)
    expect(poorReport.find((g) => g.group === 'Groceries')?.totalMinor).toBe(1_000)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/ledger/src/repo/reports.test.ts`
Expected: FAIL — argument-count type errors.

- [ ] **Step 3: Rewrite the module**

Same mechanical pass as Task 5: add `owner: OwnerId` first, wrap in `withOwner`, add `eq(<table>.ownerId, owner)` to every `where`, and scope every `innerJoin` on `accounts` with `and(eq(accounts.id, postings.accountId), eq(accounts.ownerId, owner))`.

`budgetStatus` and `flagAnomalies` call `spendReport` internally — thread `owner` through those calls too. `detectRecurring` selects across `transactions`, `postings` and `accounts`: all three need the owner predicate, not just the outermost.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/ledger/src/repo/reports.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ledger/src/repo/reports.ts packages/ledger/src/repo/reports.test.ts
git commit -m "Scope the reports repository to an owner

Every join in the analytics queries is owner-scoped, not just the outermost
select: detect_recurring reads transactions, postings and accounts together
and an unscoped join on any of the three leaks totals across tenants."
```

---

### Task 7: Scope writes, memory and tracing

**Files:**
- Modify: `packages/ledger/src/repo/writes.ts`, `packages/ledger/src/repo/tracer.ts`
- Test: `packages/ledger/src/repo/writes.test.ts`

**Interfaces:**
- Produces:
  - `listRules(owner: OwnerId)`, `setCategoryRule(owner: OwnerId, input)`, `setBudget(owner: OwnerId, input)`, `listBudgets(owner: OwnerId, month?)`, `createImportBatch(owner: OwnerId, filename, rowCount)`
  - `new DbMemoryStore(owner: OwnerId)` — the owner moves to the constructor, because `MemoryStore` is a core interface whose method signatures must not grow a ledger concept.
  - `new DbTracer(owner: OwnerId)` — same reasoning for the core `Tracer` interface.
  - `listRuns(owner: OwnerId, limit?)`, `getRun(owner: OwnerId, id: string)`, `cacheStats(owner: OwnerId)`
  - `matchRule` — **unchanged**, pure.

`DbMemoryStore` and `DbTracer` implement interfaces defined in `packages/core`. Adding `owner` to their *methods* would push a multi-tenancy concept into core, which must stay provider- and storage-neutral. Constructor injection keeps core unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ledger/src/repo/writes.test.ts
import { loadEnv } from '@kakeibo/core/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../db'
import { asOwnerId } from '../owner'
import { ensureSeedAccounts } from './accounts'
import { DbMemoryStore, listBudgets, listRules, setBudget, setCategoryRule } from './writes'

loadEnv()

const alice = asOwnerId('00000000-0000-4000-8000-00000000d111')
const bob = asOwnerId('00000000-0000-4000-8000-00000000d222')

beforeAll(async () => {
  await ensureSeedAccounts(alice)
  await ensureSeedAccounts(bob)
}, 60_000)

afterAll(async () => {
  await closeDb()
})

describe('writes are owner-scoped', () => {
  it('keeps budgets separate', async () => {
    await setBudget(alice, { category: 'Groceries', month: '2025-09', amountMinor: 111_100 })
    await setBudget(bob, { category: 'Groceries', month: '2025-09', amountMinor: 222_200 })

    expect((await listBudgets(alice, '2025-09'))[0]?.amountMinor).toBe(111_100)
    expect((await listBudgets(bob, '2025-09'))[0]?.amountMinor).toBe(222_200)
  })

  it('keeps rules separate', async () => {
    await setCategoryRule(alice, { pattern: 'ALICEMART', category: 'Groceries' })
    expect((await listRules(alice)).map((r) => r.pattern)).toContain('ALICEMART')
    expect((await listRules(bob)).map((r) => r.pattern)).not.toContain('ALICEMART')
  })

  it('keeps memories separate', async () => {
    await new DbMemoryStore(alice).save({
      content: 'alice dislikes coriander',
      category: 'preferences',
      source: 'user_stated',
    })
    expect(await new DbMemoryStore(bob).recent(20)).toEqual([])
    expect((await new DbMemoryStore(alice).recent(20)).length).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/ledger/src/repo/writes.test.ts`
Expected: FAIL — argument-count and constructor-arity type errors.

- [ ] **Step 3: Rewrite both modules**

`writes.ts`: same mechanical pass. `DbMemoryStore` becomes:

```ts
export class DbMemoryStore implements MemoryStore {
  // Owner is a constructor dependency, not a method parameter: MemoryStore is
  // a core interface and core must not learn about tenancy.
  constructor(private readonly owner: OwnerId) {}

  async recent(limit: number): Promise<Memory[]> {
    const rows = await withOwner(this.owner, (tx) =>
      tx
        .select()
        .from(memories)
        .where(eq(memories.ownerId, this.owner))
        .orderBy(desc(memories.createdAt))
        .limit(limit),
    )
    return rows.map(toMemory)
  }
  // byCategories and save follow the same shape; save stamps ownerId on insert
  // and its dedupe lookup filters on owner too.
}
```

`tracer.ts`: `DbTracer` takes `owner` in its constructor and stamps `ownerId` on both the `trace_runs` insert and every `trace_events` insert. `listRuns`, `getRun` and `cacheStats` gain `owner` first and filter on it — `getRun` returning `undefined` for another owner's run id is the behaviour the trace viewer relies on to 404.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/ledger/src/repo/writes.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/ledger/src/repo/writes.ts packages/ledger/src/repo/tracer.ts packages/ledger/src/repo/writes.test.ts
git commit -m "Scope writes, memory and tracing to an owner

DbMemoryStore and DbTracer take the owner as a constructor dependency rather
than a method parameter. Both implement interfaces defined in packages/core,
and core must not learn what a tenant is."
```

---

### Task 8: Thread the owner through tools, import, seed and every caller

**Files:**
- Modify: `packages/ledger/src/tools/index.ts`, `packages/ledger/src/import.ts`, `packages/ledger/src/scripts/seed.ts`, `packages/ledger/src/scripts/reset.ts`, `packages/ledger/src/index.ts`
- Modify: `apps/cli/src/index.ts`, `packages/mcp/src/index.ts`, `packages/evals/src/runner.ts`, `packages/evals/src/injection.ts`, `apps/web/src/app/api/chat/route.ts`, `apps/web/src/app/runs/page.tsx`, `apps/web/src/app/runs/[id]/page.tsx`
- Modify: `packages/ledger/src/ledger.test.ts`

**Interfaces:**
- Consumes: every scoped repository function from Tasks 4–7.
- Produces: `createRegistry(owner: OwnerId): ToolRegistry` and `createReadOnlyRegistry(owner: OwnerId): ToolRegistry`.

The registry becomes owner-bound rather than a module-level singleton. Each tool handler closes over the owner supplied when the registry was built, so no tool signature changes and `packages/core` is untouched — which matters, because the tool schemas are part of the cached prefix and changing them would invalidate every cache entry.

- [ ] **Step 1: Make the registry owner-bound**

In `packages/ledger/src/tools/index.ts`, wrap the tool definitions in a factory:

```ts
export function createRegistry(owner: OwnerId): ToolRegistry {
  // Tools close over the owner. Their zod schemas and descriptions are
  // unchanged, which matters: those bytes are the cached prefix, and a schema
  // that varied per owner would give every tenant a cold cache.
  const searchTool: ToolSpec<z.infer<typeof searchInput>> = {
    name: 'search_transactions',
    tier: 'read',
    description: /* unchanged */,
    input: searchInput,
    handler: async (input) => {
      const rows = await searchTransactions(owner, { /* ...unchanged... */ })
      return { /* ...unchanged... */ }
    },
  }
  // ...the other eleven tools, same treatment...
  return new ToolRegistry().registerAll([...] as unknown as ToolSpec<unknown>[])
}

export function createReadOnlyRegistry(owner: OwnerId): ToolRegistry {
  return createRegistry(owner).readOnly()
}
```

- [ ] **Step 2: Thread the owner through import and the scripts**

- `planImport(owner, filename, text, preset)` and `commitImport(owner, filename, resolved, preview, options)` — both call `requireAccount`, `listRules` and `createTransactions`.
- `scripts/seed.ts` and `scripts/reset.ts` use `DEV_OWNER_ID`, and `reset.ts`'s truncate stays global (it is a development tool that wipes the whole local database).

- [ ] **Step 3: Update the surfaces**

Each surface supplies `DEV_OWNER_ID` for now; Plan B replaces these with a session owner and this is the only line each has to change:

```ts
// apps/cli/src/index.ts, packages/mcp/src/index.ts
const owner = DEV_OWNER_ID
const registry = createRegistry(owner)
const tracer = new DbTracer(owner)
const memory = new DbMemoryStore(owner)
```

```ts
// packages/evals/src/runner.ts and injection.ts — same, plus resetAndSeed()
// seeds DEV_OWNER_ID
```

```ts
// apps/web/src/app/api/chat/route.ts, runs/page.tsx, runs/[id]/page.tsx
const owner = DEV_OWNER_ID
```

- [ ] **Step 4: Update the existing ledger test**

`packages/ledger/src/ledger.test.ts` calls the repository directly throughout. Add `DEV_OWNER_ID` as the first argument to every call, and pass `{ ownerId: DEV_OWNER_ID }` where the reseed helper builds its import.

- [ ] **Step 5: Verify the whole suite**

```bash
pnpm db:reset && pnpm db:seed
pnpm lint && pnpm typecheck && pnpm test
```

Expected: lint clean, typecheck clean, **all 109 existing tests plus the new owner-scoping tests pass**. The double-entry invariant and injection suites must be green — if either regressed, the scoping broke something real and it is not a test to update.

- [ ] **Step 6: Verify the app still behaves identically**

```bash
printf 'What did I spend on groceries in March 2025?\n/exit\n' | pnpm cli
```

Expected: `₹23,350.00` — the same number as before the plan. Multi-tenancy is meant to be invisible at one tenant.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Thread owner through tools, import, scripts and every surface

The registry becomes owner-bound: tools close over the owner supplied when it
is built, so no tool signature changes and packages/core stays untouched.
That matters because tool schemas are part of the cached prefix, and a schema
that varied per owner would hand every tenant a cold cache.

Every surface passes the fixed development owner for now; Plan B replaces
that with a session and each surface has exactly one line to change."
```

---

### Task 9: Row-level security — the backstop

**Files:**
- Create: `packages/ledger/drizzle/0002_rls.sql` (hand-written)
- Create: `packages/ledger/src/rls.test.ts`

**Interfaces:**
- Consumes: `owner_id` columns from Task 2; `withOwner` from Task 3.
- Produces: an `app_user` database role and RLS policies on all nine tables.

Drizzle Kit does not generate RLS. This migration is hand-written and numbered after the generated one.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ledger/src/rls.test.ts
import { loadEnv } from '@kakeibo/core/env'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, withOwner } from './db'
import { asOwnerId } from './owner'

loadEnv()

const alice = asOwnerId('00000000-0000-4000-8000-00000000e111')
const bob = asOwnerId('00000000-0000-4000-8000-00000000e222')

afterAll(async () => {
  await closeDb()
})

describe('row-level security backstop', () => {
  it('is enabled on every owner-scoped table', async () => {
    const result = await withOwner(alice, (tx) =>
      tx.execute(sql`
        select tablename from pg_tables
        where schemaname = 'public'
          and tablename in ('accounts','transactions','postings','rules','budgets',
                            'memories','import_batches','trace_runs','trace_events')
          and rowsecurity = false
      `),
    )
    expect(result.rows).toEqual([])
  })

  it('hides rows from a query that forgot its where clause', async () => {
    // The whole point. An UNSCOPED select, as a careless repository function
    // would issue, must still return nothing belonging to another owner.
    await withOwner(alice, (tx) =>
      tx.execute(sql`insert into accounts (owner_id, name, type) values (${alice}, 'RLS Probe', 'expense')`),
    )

    const leaked = await withOwner(bob, (tx) =>
      tx.execute(sql`select * from accounts where name = 'RLS Probe'`),
    )
    expect(leaked.rows).toEqual([])
  })

  it('refuses to write a row belonging to someone else', async () => {
    await expect(
      withOwner(bob, (tx) =>
        tx.execute(sql`insert into accounts (owner_id, name, type) values (${alice}, 'Forged', 'expense')`),
      ),
    ).rejects.toThrow(/row-level security/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/ledger/src/rls.test.ts`
Expected: FAIL — the first test lists all nine tables, because RLS is not enabled yet.

- [ ] **Step 3: Write the migration**

First, create the role. It belongs in `scripts/db-up.sh` rather than in a
migration, for two reasons: roles are cluster-level objects, not schema, and
its password must never be committed. Add to `scripts/db-up.sh`, after the
database is created:

```bash
# The application role. Distinct from the owning role: app_user does not own
# the tables, so row-level security applies to it. The password here is a
# local development convenience, exactly like the kakeibo/kakeibo pair above;
# production (Neon) sets it out of band and supplies it via APP_DATABASE_URL.
PGPASSWORD="$PASSWORD" psql -h localhost -p "$PORT" -U "$USER_NAME" -d "$DB" -q <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user';
  END IF;
END
$$;
SQL
```

Then the migration, which only grants and enables policies:

```sql
-- packages/ledger/drizzle/0002_rls.sql
-- Row-level security: the backstop under the repository layer's explicit
-- scoping. A forgotten `where owner_id = ...` returns zero rows instead of
-- another tenant's ledger.
--
-- The application connects as app_user, which does NOT own these tables and is
-- therefore subject to the policies. Migrations, seeding and the eval harness
-- connect as the table owner, which bypasses RLS by default - that is what
-- lets `pnpm db:seed` write rows for any owner.
--
-- The role itself is created by scripts/db-up.sh: roles are cluster-level and
-- its password must not live in git.

GRANT USAGE ON SCHEMA public TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
--> statement-breakpoint

-- accounts
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "accounts_owner" ON "accounts"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

-- transactions
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "transactions_owner" ON "transactions"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

-- postings
ALTER TABLE "postings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "postings_owner" ON "postings"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

-- rules
ALTER TABLE "rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "rules_owner" ON "rules"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

-- budgets
ALTER TABLE "budgets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "budgets_owner" ON "budgets"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

-- memories
ALTER TABLE "memories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "memories_owner" ON "memories"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

-- import_batches
ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_batches_owner" ON "import_batches"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

-- trace_runs
ALTER TABLE "trace_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "trace_runs_owner" ON "trace_runs"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
--> statement-breakpoint

-- trace_events
ALTER TABLE "trace_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "trace_events_owner" ON "trace_events"
  USING (owner_id = current_setting('app.owner_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.owner_id', true)::uuid);
```

Append the file to `packages/ledger/drizzle/meta/_journal.json` following the shape of the existing entries, so `pnpm db:migrate` picks it up.

- [ ] **Step 4: Point the application at the restricted role**

Do this **before** applying the migration. A migration that has already run will
not re-run when edited, so anything discovered later means a new numbered file.

Add to `.env` and `.env.example` (empty value in the example — it carries a
password):

```
# Application connection. Distinct from DATABASE_URL: this role does NOT own
# the tables, so row-level security applies to it. DATABASE_URL is used by
# migrations, seeding and evals, which must be able to write for any owner.
APP_DATABASE_URL=postgres://app_user:app_user@localhost:5433/kakeibo
```

Add `APP_DATABASE_URL: z.string().default('')` to the env schema in
`packages/core/src/env.ts`, then make `getDb()` prefer it:

```ts
// packages/ledger/src/db.ts
// The app connects as the restricted role when one is configured. adminDb()
// keeps using DATABASE_URL, which is how migrations, seeding and evals stay
// able to write rows for any owner.
const connectionString = env().APP_DATABASE_URL || env().DATABASE_URL
```

- [ ] **Step 5: Bring up the role, apply the migration**

```bash
pnpm db:down && pnpm db:up   # recreates the cluster role
pnpm db:migrate
```

Expected: migration applies cleanly. Verify the role exists and is restricted:

```bash
PGPASSWORD=kakeibo psql -h localhost -p 5433 -U kakeibo -d kakeibo -tA -c \
  "select rolname, rolbypassrls from pg_roles where rolname = 'app_user'"
```

Expected: `app_user|f` — it does **not** bypass RLS. If that says `t`, the
backstop is inert and every later test is meaningless.

- [ ] **Step 6: Run the test to verify all three pass**

Run: `npx vitest run packages/ledger/src/rls.test.ts`
Expected: PASS, 3 tests — including the forged-insert rejection.

- [ ] **Step 7: Run the full suite**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Expected: everything green. If seeding now fails, `pnpm db:seed` is connecting as `app_user` — it must use `DATABASE_URL` via `adminDb()`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Add row-level security as the isolation backstop

Explicit scoping in the repository is the mechanism; this is what catches the
query that eventually forgets it. The application connects as app_user, which
does not own the tables and is therefore subject to the policies; migrations,
seeding and evals keep the owning connection so they can write for any owner.

The forged-insert test is the one that matters: it proves WITH CHECK stops an
owner writing a row stamped with someone else's id, which USING alone does
not."
```

---

### Task 10: The cross-tenant isolation suite

**Files:**
- Create: `packages/ledger/src/isolation.test.ts`

**Interfaces:**
- Consumes: every scoped repository function.
- Produces: nothing — this task is the proof of success criterion 2.

Tasks 4–7 each tested their own module. This suite is the systematic one: it seeds two complete ledgers and asserts that **every** read function returns only its own owner's rows. Written as a table so adding a repository function without adding it here is visible in review.

- [ ] **Step 1: Write the test**

```ts
// packages/ledger/src/isolation.test.ts
import { loadEnv } from '@kakeibo/core/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toCsv } from './csv'
import { closeDb } from './db'
import { commitImport, planImport } from './import'
import { minorToDecimalString } from './money'
import { asOwnerId, type OwnerId } from './owner'
import { accountBalances, ensureSeedAccounts, listAccounts } from './repo/accounts'
import {
  budgetStatus,
  detectRecurring,
  flagAnomalies,
  monthToPeriod,
  spendReport,
} from './repo/reports'
import { searchTransactions } from './repo/transactions'
import { listBudgets, listRules } from './repo/writes'
import { generateSeedData } from './seed/generate'

loadEnv()

const alice = asOwnerId('00000000-0000-4000-8000-00000000f111')
const bob = asOwnerId('00000000-0000-4000-8000-00000000f222')
const seed = generateSeedData()

async function seedLedger(owner: OwnerId): Promise<void> {
  await ensureSeedAccounts(owner)
  const csv = toCsv(
    seed.rows.map((row) => ({
      date: row.date,
      description: row.description,
      amount: minorToDecimalString(row.amountMinor),
      category: row.csvCategory,
    })),
    ['date', 'description', 'amount', 'category'],
  )
  const { preview, resolved } = await planImport(owner, 'iso.csv', csv, 'sample')
  await commitImport(owner, 'iso.csv', resolved, preview)
}

beforeAll(async () => {
  await seedLedger(alice)
  // Bob gets accounts but NO transactions. Every read below must therefore
  // come back empty for him — a far sharper assertion than "different", which
  // an off-by-one scoping bug could still satisfy.
  await ensureSeedAccounts(bob)
}, 180_000)

afterAll(async () => {
  await closeDb()
})

describe('cross-tenant isolation', () => {
  it('gives Alice a full ledger', async () => {
    expect((await searchTransactions(alice, { limit: 500 })).length).toBeGreaterThan(300)
  })

  const emptyForBob: [string, (owner: OwnerId) => Promise<unknown[]>][] = [
    ['searchTransactions', (o) => searchTransactions(o, { limit: 500 })],
    ['spendReport', (o) => spendReport(o, monthToPeriod('2025-03'), 'category')],
    ['detectRecurring', (o) => detectRecurring(o, 3)],
    ['flagAnomalies', (o) => flagAnomalies(o, '2025-04')],
    ['budgetStatus', (o) => budgetStatus(o, '2025-03')],
    ['listRules', (o) => listRules(o)],
    ['listBudgets', (o) => listBudgets(o)],
  ]

  for (const [name, read] of emptyForBob) {
    it(`${name} returns nothing of Alice's to Bob`, async () => {
      expect(await read(bob)).toEqual([])
    })
  }

  it('gives Bob his own accounts but with zero balances', async () => {
    const accounts = await listAccounts(bob)
    expect(accounts.length).toBeGreaterThan(0)

    const balances = await accountBalances(bob)
    expect(balances.every((b) => b.balanceMinor === 0 && b.postingCount === 0)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run packages/ledger/src/isolation.test.ts`
Expected: PASS, 10 tests. **Any failure here is a real cross-tenant leak, not a flaky test** — fix the repository function, never the assertion.

- [ ] **Step 3: Run everything**

```bash
pnpm db:reset && pnpm db:seed
pnpm lint && pnpm typecheck && pnpm test
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages/ledger/src/isolation.test.ts
git commit -m "Add the cross-tenant isolation suite

Bob gets a chart of accounts and no transactions, so every read must come
back empty for him. That is a sharper assertion than 'different results':
an off-by-one scoping bug can still produce different results, but it cannot
produce an empty one.

Table-driven so that adding a repository read without adding it here is
visible in review."
```

---

### Task 11: Update the spec and the documentation

**Files:**
- Modify: `docs/kakeibo_spec.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Amend the spec's non-goals**

The launch prompt requires this. In `docs/kakeibo_spec.md` §3, replace the first non-goal:

```markdown
- ~~No user accounts, auth, or multi-tenancy — single-user local app.~~
  **Superseded 2026-08-09.** kakeibo is going public; accounts and
  multi-tenancy are now in scope. See
  `docs/superpowers/specs/2026-08-09-public-launch-design.md`. Tenant isolation
  is explicit `ownerId` scoping in the repository layer plus Postgres RLS.
```

- [ ] **Step 2: Record the rule in CLAUDE.md**

Under "Ground rules from the spec", add:

```markdown
7. **Every ledger query is owner-scoped.** Repository functions take `OwnerId`
   as their first parameter, and Postgres RLS refuses unscoped reads. If you add
   a repository read, add it to `packages/ledger/src/isolation.test.ts` — a
   function missing from that table is a leak waiting to happen.
```

- [ ] **Step 3: Note the two connections in the README**

Under the quick start, after the `db:up` line:

```markdown
kakeibo uses two database roles. `DATABASE_URL` owns the tables and is used by
migrations, seeding and evals, which must write rows for any owner.
`APP_DATABASE_URL` connects as `app_user`, which does not own the tables and is
therefore subject to row-level security — that is the connection the application
uses, and the reason a forgotten `where owner_id = ...` returns nothing instead
of someone else's ledger.
```

- [ ] **Step 4: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add -A
git commit -m "Record multi-tenancy in the spec, CLAUDE.md and README

The spec's 'no accounts or multi-tenancy' non-goal was right for the
portfolio phase and is now superseded rather than deleted, so the history of
the decision stays legible."
```

---

## Self-Review

**Spec coverage.** §3.1 owner column → Task 2. §3.2 uniqueness → Task 2 Step 2. §4.1 explicit scoping → Tasks 4–8. §4.2 RLS → Task 9. Success criterion 2 → Task 10. §13's note to amend the spec → Task 11.

Deliberately **not** covered by this plan, and each has a home: §2 identity, §3.3 new tables, §3.4 user columns, §5 cost control, §6 suspendable loop, §10 environments → **Plan B**. §3.5 geolocation, §9 admin dashboard → **Plan C**. §7 surfaces and §8 privacy copy → **Phase 2 UI**.

**Placeholder scan.** No TBDs. The one place this plan says "same mechanical pass as Task 5" (Tasks 6 and 7) names the five specific transformations rather than pointing at a neighbouring task, and shows the non-mechanical cases in full.

**Type consistency.** `OwnerId` is the parameter type in every signature. `withOwner(owner, fn)` argument order is identical in Tasks 3–7. `Tx` is defined once in Task 3 and referenced by name thereafter. `DEV_OWNER_ID` is defined in Task 1 and used in Tasks 2, 8 and 11. `ensureSeedAccounts(owner)` is used with that arity in Tasks 4, 5, 6, 7 and 10.

**Two defects this review caught and fixed.** Task 9 originally had the engineer
edit a migration *after* applying it, which never re-runs — the role setup now
happens before `pnpm db:migrate` and any later discovery means a new numbered
file. It also put the `app_user` password in a committed migration, violating
this plan's own "secrets never in git" constraint; role creation moved to
`scripts/db-up.sh`, where a local development password sits alongside the
existing `kakeibo/kakeibo` pair and production supplies its own via
`APP_DATABASE_URL`.

**One risk worth naming.** Task 8 changes eleven files across five packages in a single commit. It is not splittable: the moment `createRegistry` takes an owner, every caller stops compiling. The safeguard is Step 6 — the CLI must still answer `₹23,350.00`, exactly as it did before the plan began.
