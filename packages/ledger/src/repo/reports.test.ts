import { loadEnv } from '@kakeibo/core/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../db'
import { resetOwners } from '../testing'
import { asOwnerId } from '../owner'
import { ensureSeedAccounts, requireAccount } from './accounts'
import { monthToPeriod, spendReport } from './reports'
import { createTransaction } from './transactions'

loadEnv()

const rich = asOwnerId('00000000-0000-4000-8000-00000000c111')
const poor = asOwnerId('00000000-0000-4000-8000-00000000c222')

beforeAll(async () => {
  await resetOwners(rich, poor)
  for (const [owner, minor] of [
    [rich, 1_000_000],
    [poor, 1_000],
  ] as const) {
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
  it("does not add another owner's spending into the total", async () => {
    const richReport = await spendReport(rich, monthToPeriod('2025-03'), 'category')
    const poorReport = await spendReport(poor, monthToPeriod('2025-03'), 'category')

    expect(richReport.find((g) => g.group === 'Groceries')?.totalMinor).toBe(1_000_000)
    expect(poorReport.find((g) => g.group === 'Groceries')?.totalMinor).toBe(1_000)
  })
})
