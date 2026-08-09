import { loadEnv } from '@kakeibo/core/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../db'
import { asOwnerId } from '../owner'
import { resetOwners } from '../testing'
import { ensureLedger } from './demo'
import { searchTransactions } from './transactions'

loadEnv()

const first = asOwnerId('00000000-0000-4000-8000-00000000ce01')
const second = asOwnerId('00000000-0000-4000-8000-00000000ce02')

beforeAll(async () => {
  await resetOwners(first, second)
}, 60_000)

afterAll(async () => {
  await closeDb()
})

describe('ensureLedger', () => {
  it('clones the corpus on first call and does nothing on the second', async () => {
    expect(await ensureLedger(first)).toEqual({ created: true })
    const cloned = await searchTransactions(first, { limit: 500 })
    expect(cloned.length).toBe(352)

    expect(await ensureLedger(first)).toEqual({ created: false })
    expect((await searchTransactions(first, { limit: 500 })).length).toBe(352)
  }, 60_000)

  it('gives a second visitor their own copy', async () => {
    // The seed script uses reproducible primary keys derived from the CSV row,
    // which carry no owner — cloning with those would collide on the second
    // visitor and the whole per-visitor demo would be one visitor deep.
    expect(await ensureLedger(second)).toEqual({ created: true })
    const theirs = await searchTransactions(second, { limit: 500 })
    expect(theirs.length).toBe(352)

    const mine = await searchTransactions(first, { limit: 500 })
    const sharedIds = new Set(mine.map((t) => t.id))
    expect(theirs.some((t) => sharedIds.has(t.id))).toBe(false)
  }, 60_000)
})
