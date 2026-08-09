import { loadEnv } from '@kakeibo/core'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { UNCATEGORIZED } from './categories'
import { toCsv } from './csv'
import { adminDb, closeDb, getDb } from './db'
import { commitImport, planImport } from './import'
import { minorToDecimalString } from './money'
import { DEV_OWNER_ID } from './owner'
import { ensureSeedAccounts, requireAccount } from './repo/accounts'
import {
  budgetStatus,
  detectRecurring,
  flagAnomalies,
  monthToPeriod,
  spendReport,
} from './repo/reports'
import {
  assertBalanced,
  categorizeTransactions,
  createTransaction,
  findUnbalancedTransactions,
  searchTransactions,
  UnbalancedTransactionError,
} from './repo/transactions'
import { setBudget } from './repo/writes'
import { generateSeedData } from './seed/generate'

/**
 * Ledger integration tests against a real Postgres (spec 7).
 *
 * These need the database from `pnpm db:up`. The invariant test is the point:
 * the zero-sum rule lives in the repository layer rather than in a trigger, so
 * a test that can actually reach that layer is the only thing keeping it honest.
 */

loadEnv()

const seed = generateSeedData()

async function reseed(): Promise<void> {
  await getDb().execute(
    sql`truncate table trace_events, trace_runs, postings, transactions, import_batches, budgets, rules, memories, accounts restart identity cascade`,
  )
  await ensureSeedAccounts(DEV_OWNER_ID)
  const csv = toCsv(
    seed.rows.map((row) => ({
      date: row.date,
      description: row.description,
      amount: minorToDecimalString(row.amountMinor),
      category: row.csvCategory,
    })),
    ['date', 'description', 'amount', 'category'],
  )
  const { preview, resolved } = await planImport(DEV_OWNER_ID, 'test-seed.csv', csv, 'sample')
  await commitImport(DEV_OWNER_ID, 'test-seed.csv', resolved, preview, { deterministicIds: true })
}

beforeAll(async () => {
  await reseed()
}, 120_000)

afterAll(async () => {
  await closeDb()
})

describe('double-entry invariant', () => {
  it('holds across the entire seeded ledger', async () => {
    const unbalanced = await findUnbalancedTransactions(DEV_OWNER_ID)
    expect(unbalanced).toEqual([])
  })

  it('refuses postings that do not sum to zero', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'a', amountMinor: 100 },
        { accountId: 'b', amountMinor: -99 },
      ]),
    ).toThrow(UnbalancedTransactionError)
  })

  it('refuses a single-sided transaction', () => {
    expect(() => assertBalanced([{ accountId: 'a', amountMinor: 100 }])).toThrow(
      UnbalancedTransactionError,
    )
  })

  it('rejects an unbalanced insert at the repository, not in the database', async () => {
    const checking = await requireAccount(DEV_OWNER_ID, 'Checking')
    const groceries = await requireAccount(DEV_OWNER_ID, 'Groceries')
    await expect(
      createTransaction(DEV_OWNER_ID, {
        date: '2025-03-01',
        description: 'BROKEN',
        postings: [
          { accountId: checking.id, amountMinor: -1000 },
          { accountId: groceries.id, amountMinor: 999 },
        ],
      }),
    ).rejects.toThrow(UnbalancedTransactionError)

    // And nothing was written on the way to failing.
    const found = await searchTransactions(DEV_OWNER_ID, { query: 'BROKEN' })
    expect(found).toHaveLength(0)
  })

  it('stays balanced after categorising, because categorising repoints a posting', async () => {
    const uncategorized = await searchTransactions(DEV_OWNER_ID, {
      account: UNCATEGORIZED,
      limit: 5,
    })
    expect(uncategorized.length).toBeGreaterThan(0)

    const result = await categorizeTransactions(
      DEV_OWNER_ID,
      uncategorized.map((t) => t.id),
      'Groceries',
    )
    expect(result.updated).toBe(uncategorized.length)
    expect(await findUnbalancedTransactions(DEV_OWNER_ID)).toEqual([])

    await reseed() // leave the ledger as the other tests expect it
  })
})

describe('seed data', () => {
  it('imports every generated row', async () => {
    const [row] = await getDb()
      .execute<{ count: string }>(sql`select count(*)::text as count from transactions`)
      .then((r) => r.rows as { count: string }[])
    expect(Number(row?.count)).toBe(seed.rows.length)
  })

  it('is deterministic: regenerating produces identical rows', () => {
    const again = generateSeedData()
    expect(JSON.stringify(again.rows)).toBe(JSON.stringify(seed.rows))
  })

  it('lands roughly 8% of rows in Uncategorized', async () => {
    const rows = await searchTransactions(DEV_OWNER_ID, { account: UNCATEGORIZED, limit: 500 })
    const ratio = rows.length / seed.rows.length
    expect(ratio).toBeGreaterThan(0.05)
    expect(ratio).toBeLessThan(0.11)
  })

  it('contains all six hostile descriptions verbatim', async () => {
    for (const hostile of seed.labels.hostile) {
      const found = await searchTransactions(DEV_OWNER_ID, {
        query: hostile.description.slice(0, 40),
        limit: 5,
      })
      expect(found.length).toBeGreaterThan(0)
    }
  })
})

describe('reports', () => {
  it('spend report totals match a direct SQL sum', async () => {
    const period = monthToPeriod('2025-03')
    const groups = await spendReport(DEV_OWNER_ID, period, 'category')
    const fromReport = groups.reduce((sum, g) => sum + g.totalMinor, 0)

    const result = await getDb().execute<{ total: string }>(sql`
      select coalesce(sum(p.amount_minor), 0)::text as total
      from postings p
      join transactions t on t.id = p.transaction_id
      join accounts a on a.id = p.account_id
      where a.type = 'expense' and t.date between ${period.from} and ${period.to}
    `)
    const fromSql = Number((result.rows as { total: string }[])[0]?.total)

    expect(fromReport).toBe(fromSql)
  })

  it('groups by month across the whole seeded range', async () => {
    const groups = await spendReport(
      DEV_OWNER_ID,
      { from: '2025-01-01', to: '2025-06-30' },
      'month',
    )
    expect(groups.map((g) => g.group).sort()).toEqual([
      '2025-01',
      '2025-02',
      '2025-03',
      '2025-04',
      '2025-05',
      '2025-06',
    ])
  })

  it('finds every planted recurring merchant', async () => {
    const found = await detectRecurring(DEV_OWNER_ID, 3)
    const keys = found.map((m) => m.merchant)

    for (const expected of [
      'NETFLIX COM',
      'SPOTIFY INDIA',
      'CULT FIT GYM',
      'GOOGLE CLOUD STORAGE',
    ]) {
      expect(keys, `expected ${expected} among ${keys.join(', ')}`).toContain(expected)
    }
    expect(found.every((m) => m.cadence !== 'irregular')).toBe(true)
  })

  it('finds the planted outlier, duplicate and refund', async () => {
    const april = await flagAnomalies(DEV_OWNER_ID, '2025-04')
    expect(april.some((a) => a.kind === 'outlier' && a.description.includes('BULK PURCHASE'))).toBe(
      true,
    )

    const may = await flagAnomalies(DEV_OWNER_ID, '2025-05')
    expect(may.some((a) => a.kind === 'duplicate' && a.description.includes('CROMA'))).toBe(true)
    expect(may.some((a) => a.kind === 'refund' && a.description.includes('REFUND'))).toBe(true)
  })

  it('reports budget versus actual, including categories with no budget', async () => {
    await setBudget(DEV_OWNER_ID, {
      category: 'Groceries',
      month: '2025-03',
      amountMinor: 2_000_000,
    })
    const rows = await budgetStatus(DEV_OWNER_ID, '2025-03')

    const groceries = rows.find((r) => r.category === 'Groceries')
    expect(groceries?.budgetMinor).toBe(2_000_000)
    expect(groceries?.actualMinor).toBeGreaterThan(0)
    expect(groceries?.remainingMinor).toBe(2_000_000 - groceries!.actualMinor)

    const dining = rows.find((r) => r.category === 'Dining')
    expect(dining?.budgetMinor).toBeNull()
    expect(dining?.actualMinor).toBeGreaterThan(0)
  })
})

describe('search', () => {
  it('filters by account, date range and amount together', async () => {
    const rows = await searchTransactions(DEV_OWNER_ID, {
      account: 'Groceries',
      from: '2025-03-01',
      to: '2025-03-31',
      limit: 100,
    })
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.date >= '2025-03-01' && row.date <= '2025-03-31').toBe(true)
      expect(row.postings.some((p) => p.account === 'Groceries')).toBe(true)
    }
  })

  it('returns nothing rather than guessing when there is no match', async () => {
    expect(await searchTransactions(DEV_OWNER_ID, { query: 'NONEXISTENT MERCHANT ZZZ' })).toEqual(
      [],
    )
  })

  it('rejects an unknown account with the list of real ones', async () => {
    await expect(searchTransactions(DEV_OWNER_ID, { account: 'Petrol' })).rejects.toThrow(
      /Known accounts/,
    )
  })
})
