import { loadEnv } from '@kakeibo/core/env'
import { eq, getTableName, is, sql, Table } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminDb, closeDb } from '../db'
import { asOwnerId, type OwnerId } from '../owner'
import * as ledgerSchema from '../schema'
import { resetOwners } from '../testing'
import { ensureSeedAccounts, listAccounts, requireAccount } from './accounts'
import { createConversation, replaceHistory, saveSuspendedTurn } from './conversations'
import { OWNER_SCOPED_TABLES, repointOwner } from './link'
import { DbTracer } from './tracer'
import { createTransaction, searchTransactions } from './transactions'
import { deleteUser, ensureOwnerUser } from './users'
import { createImportBatch, DbMemoryStore, listBudgets, setBudget, setCategoryRule } from './writes'

loadEnv()

const anon = asOwnerId('00000000-0000-4000-8000-00000000aa01')
const fresh = asOwnerId('00000000-0000-4000-8000-00000000aa02')
const settled = asOwnerId('00000000-0000-4000-8000-00000000aa03')
const doomed = asOwnerId('00000000-0000-4000-8000-00000000aa04')
const erased = asOwnerId('00000000-0000-4000-8000-00000000aa05')
const bystander = asOwnerId('00000000-0000-4000-8000-00000000aa06')

/** A small ledger: two accounts, one balanced transaction, one budget. */
async function giveLedger(owner: OwnerId, description: string): Promise<void> {
  await ensureSeedAccounts(owner)
  const checking = await requireAccount(owner, 'Checking')
  const groceries = await requireAccount(owner, 'Groceries')
  await createTransaction(owner, {
    date: '2025-03-01',
    description,
    postings: [
      { accountId: checking.id, amountMinor: -5000 },
      { accountId: groceries.id, amountMinor: 5000 },
    ],
  })
  await setBudget(owner, { category: groceries.name, month: '2025-03', amountMinor: 100_000 })
}

/**
 * Every table in the schema that carries an `owner_id`, derived rather than
 * listed — the same trick the coverage assertion below uses, and for the same
 * reason: a hand-written list here would be one table behind the schema the
 * first time someone adds one.
 */
function ownedTables(): (typeof ledgerSchema.accounts)[] {
  return (
    Object.values(ledgerSchema)
      .filter((value) => is(value, Table) && 'ownerId' in value)
      // The same narrow cast link.ts documents: every one of these tables has
      // exactly the `owner_id uuid` column being read, but Drizzle types each
      // table from its own row type, so a loop over twelve of them has no single
      // type that satisfies all of them.
      .map((value) => value as typeof ledgerSchema.accounts)
  )
}

/** How many rows this owner has in each owner-scoped table. */
async function ownedRowCounts(owner: OwnerId): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const table of ownedTables()) {
    // adminDb, not withOwner: this counts what is in the database rather than
    // what the application can see, which is the only reading that says
    // anything about a cascade.
    const [row] = await adminDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(eq(table.ownerId, owner))
    counts[getTableName(table)] = row?.n ?? 0
  }
  return counts
}

/** A row in every owner-scoped table, so the cascade has something to prove. */
async function giveEverything(owner: OwnerId, description: string): Promise<void> {
  await giveLedger(owner, description)
  await setCategoryRule(owner, { pattern: description, category: 'Groceries' })
  await createImportBatch(owner, 'erased.csv', 1)
  await new DbMemoryStore(owner).save({
    content: 'prefers weekly summaries',
    category: 'preference',
    source: 'user_stated',
  })

  const conversation = await createConversation(owner, description)
  await replaceHistory(owner, conversation.id, [
    { role: 'user', content: [{ type: 'text', text: 'what did I spend on groceries?' }] },
  ])
  await saveSuspendedTurn(owner, conversation.id, {
    runId: '33333333-3333-4333-8333-333333333333',
    history: [],
    completedResults: [],
    pending: [{ id: 'w1', tool: 'set_budget', args: {}, summary: 'set a budget' }],
    usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 0, thoughtTokens: 0 },
    costUsdEst: 0.0001,
    iterations: 1,
  })

  const run = await new DbTracer(owner).startRun({
    provider: 'gemini',
    model: 'test',
    channel: 'web',
  })
  await run.event({ type: 'tool_call', payload: { name: 'search_transactions' } })
}

beforeAll(async () => {
  await resetOwners(anon, fresh, settled, doomed, erased, bystander)
  await giveLedger(anon, 'ANON PURCHASE')
  await giveLedger(settled, 'SETTLED PURCHASE')
}, 60_000)

afterAll(async () => {
  await closeDb()
})

describe('repointOwner', () => {
  it('moves the whole ledger when the new owner has none', async () => {
    expect(await searchTransactions(anon, { query: 'ANON PURCHASE', limit: 10 })).toHaveLength(1)

    const result = await repointOwner(anon, fresh)
    expect(result.outcome).toBe('moved')

    expect(await searchTransactions(anon, { query: 'ANON PURCHASE', limit: 10 })).toEqual([])
    const after = await searchTransactions(fresh, { query: 'ANON PURCHASE', limit: 10 })
    expect(after).toHaveLength(1)
    // The postings moved too, or the transaction is a shell with no money in it.
    expect(after[0]?.postings).toHaveLength(2)
    // And everything else hanging off the same owner.
    expect(await listAccounts(fresh)).not.toHaveLength(0)
    expect(await listBudgets(fresh, '2025-03')).toHaveLength(1)
    expect(await listAccounts(anon)).toEqual([])
  })

  it('leaves nothing behind that would block deleting the anonymous user', async () => {
    // This is the real deadline: the plugin deletes the anonymous user the
    // moment the hook returns. A row still pointing at it would either abort
    // that delete or be swept away by the cascade.
    await ensureOwnerUser(anon)
    expect(await deleteUser(anon)).toBe(true)
    expect(await searchTransactions(fresh, { query: 'ANON PURCHASE', limit: 10 })).toHaveLength(1)
  })

  it('discards the anonymous ledger when the new owner already has one', async () => {
    // Every ledger is a clone of the same synthetic corpus, so both owners have
    // an account called "Groceries" and accounts is unique on (owner_id, name).
    // Repointing on top of that is a constraint violation, and merging would
    // double every figure in every report. The account they signed in to is the
    // ledger they came back for.
    await giveLedger(doomed, 'DOOMED PURCHASE')

    const result = await repointOwner(doomed, settled)
    expect(result.outcome).toBe('discarded')

    expect(await searchTransactions(doomed, { query: 'DOOMED PURCHASE', limit: 10 })).toEqual([])
    expect(await searchTransactions(settled, { query: 'DOOMED PURCHASE', limit: 10 })).toEqual([])
    // Untouched.
    expect(
      await searchTransactions(settled, { query: 'SETTLED PURCHASE', limit: 10 }),
    ).toHaveLength(1)
    expect(await listBudgets(settled, '2025-03')).toHaveLength(1)
  })
})

/**
 * `deleteUser` lives in `users.ts`, but its test belongs beside `repointOwner`:
 * the two are the same argument from opposite ends. Repointing has to leave
 * nothing behind because the cascade is about to fire; deleting has to take
 * everything with it because the cascade is the whole implementation.
 */
describe('deleting the account', () => {
  it('takes every owner-scoped table with it, and touches nobody else', async () => {
    // This is what /privacy promises in one sentence, and CLAUDE.md rule 7 says
    // is the entire mechanism: `owner_id` references `"user"(id) on delete
    // cascade`, so one delete removes the ledger, the conversation, the traces
    // and any suspended turn. Derived from the schema rather than sampled, so
    // that a new owner-scoped table without its cascade fails here rather than
    // making the promise on the privacy page quietly false.
    await giveEverything(erased, 'ERASED PURCHASE')
    await giveEverything(bystander, 'BYSTANDER PURCHASE')

    const before = await ownedRowCounts(erased)
    expect(Object.keys(before).sort()).toEqual([...OWNER_SCOPED_TABLES].sort())
    for (const [table, count] of Object.entries(before)) {
      expect(count, `${table} should have been seeded`).toBeGreaterThan(0)
    }

    expect(await deleteUser(erased)).toBe(true)

    const after = await ownedRowCounts(erased)
    for (const [table, count] of Object.entries(after)) {
      expect(count, `${table} survived the cascade`).toBe(0)
    }

    // The neighbour is untouched — a delete that took the whole table with it
    // would pass every assertion above.
    const theirs = await ownedRowCounts(bystander)
    for (const [table, count] of Object.entries(theirs)) {
      expect(count, `${table} lost the bystander's rows`).toBe(before[table])
    }
    expect(
      await searchTransactions(bystander, { query: 'BYSTANDER PURCHASE', limit: 10 }),
    ).toHaveLength(1)
  }, 60_000)

  it('is a no-op the second time', async () => {
    // The reaper and a double-clicked button both do this, and neither is an
    // error. `erased` is already gone from the test above.
    expect(await deleteUser(erased)).toBe(false)
  })
})

describe('the owner-scoped table list', () => {
  it('covers every table in the schema that has an owner_id', () => {
    // A table missing from the list is a ledger fragment that outlives its
    // owner: repointing leaves it behind, and the cascade then deletes it out
    // from under the account that should have inherited it. Deriving the
    // expected set from the schema means adding a table cannot quietly skip it.
    const inSchema = Object.values(ledgerSchema)
      .filter((value) => is(value, Table) && 'ownerId' in value)
      .map((table) => getTableName(table as Table))

    expect([...OWNER_SCOPED_TABLES].sort()).toEqual(inSchema.sort())
  })
})
