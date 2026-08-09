import { loadEnv } from '@kakeibo/core/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../db'
import { asOwnerId, type OwnerId } from '../owner'
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

async function spend(owner: OwnerId, description: string, minor: number) {
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
  it("never returns another owner's transactions from a search", async () => {
    const aliceRows = await searchTransactions(alice, { query: 'SECRET SHOP', limit: 50 })
    expect(aliceRows.map((r) => r.description)).toEqual(['ALICE SECRET SHOP'])

    const bobRows = await searchTransactions(bob, { query: 'SECRET SHOP', limit: 50 })
    expect(bobRows.map((r) => r.description)).toEqual(['BOB SECRET SHOP'])
  })

  it("will not fetch another owner's transaction even by exact id", async () => {
    const [bobRow] = await searchTransactions(bob, { query: 'BOB SECRET', limit: 1 })
    expect(bobRow).toBeDefined()

    // Guessing an id must not be enough. This is the attack the whole plan
    // exists to stop.
    const stolen = await transactionsByIds(alice, [bobRow!.id])
    expect(stolen).toEqual([])
  })

  it("will not categorise another owner's transaction", async () => {
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
