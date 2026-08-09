import { loadEnv } from '@kakeibo/core/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../db'
import { asOwnerId } from '../owner'
import { resetOwners } from '../testing'
import { ensureSeedAccounts } from './accounts'
import { DbMemoryStore, listBudgets, listRules, setBudget, setCategoryRule } from './writes'

loadEnv()

const alice = asOwnerId('00000000-0000-4000-8000-00000000d111')
const bob = asOwnerId('00000000-0000-4000-8000-00000000d222')

beforeAll(async () => {
  await resetOwners(alice, bob)
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
