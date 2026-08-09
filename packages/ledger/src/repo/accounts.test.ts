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

  it("resolves a name to the asking owner's account", async () => {
    const aliceGroceries = await accountByName(alice, 'Groceries')
    const bobGroceries = await accountByName(bob, 'Groceries')

    expect(aliceGroceries).toBeDefined()
    expect(bobGroceries).toBeDefined()
    expect(aliceGroceries?.id).not.toBe(bobGroceries?.id)
  })
})
