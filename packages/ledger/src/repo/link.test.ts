import { loadEnv } from '@kakeibo/core/env'
import { getTableName, is, Table } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../db'
import { asOwnerId, type OwnerId } from '../owner'
import * as ledgerSchema from '../schema'
import { resetOwners } from '../testing'
import { ensureSeedAccounts, listAccounts, requireAccount } from './accounts'
import { OWNER_SCOPED_TABLES, repointOwner } from './link'
import { createTransaction, searchTransactions } from './transactions'
import { deleteUser, ensureOwnerUser } from './users'
import { listBudgets, setBudget } from './writes'

loadEnv()

const anon = asOwnerId('00000000-0000-4000-8000-00000000aa01')
const fresh = asOwnerId('00000000-0000-4000-8000-00000000aa02')
const settled = asOwnerId('00000000-0000-4000-8000-00000000aa03')
const doomed = asOwnerId('00000000-0000-4000-8000-00000000aa04')

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

beforeAll(async () => {
  await resetOwners(anon, fresh, settled, doomed)
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
