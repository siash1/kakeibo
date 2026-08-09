import { loadEnv } from '@kakeibo/core/env'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { user } from '../auth-schema'
import { adminDb, closeDb } from '../db'
import { asOwnerId, type OwnerId } from '../owner'
import { rateLimits } from '../schema'
import { createConversation, saveSuspendedTurn } from './conversations'
import { ensureLedger } from './demo'
import { reap } from './reaper'
import { searchTransactions } from './transactions'
import { userExists } from './users'

loadEnv()

const aged = asOwnerId('00000000-0000-4000-8000-00000000ba01')
const fresh = asOwnerId('00000000-0000-4000-8000-00000000ba02')
const member = asOwnerId('00000000-0000-4000-8000-00000000ba03')
const legacy = asOwnerId('00000000-0000-4000-8000-00000000ba04')

const DAY_MS = 24 * 60 * 60_000

/** Inserts a principal with a chosen age and kind, which ensureOwnerUser cannot. */
async function makeUser(
  id: OwnerId,
  options: { ageMs: number; isAnonymous: boolean | null },
): Promise<void> {
  await adminDb().delete(user).where(eq(user.id, id))
  await adminDb()
    .insert(user)
    .values({
      id,
      name: 'reaper probe',
      email: `${id}@kakeibo.local`,
      emailVerified: false,
      isAnonymous: options.isAnonymous,
      createdAt: new Date(Date.now() - options.ageMs),
      updatedAt: new Date(),
    })
}

beforeAll(async () => {
  await makeUser(aged, { ageMs: 25 * 60 * 60_000, isAnonymous: true })
  await makeUser(fresh, { ageMs: 60_000, isAnonymous: true })
  await makeUser(member, { ageMs: 30 * DAY_MS, isAnonymous: false })
  // A row from before the anonymous plugin ever set the column.
  await makeUser(legacy, { ageMs: 30 * DAY_MS, isAnonymous: null })

  await ensureLedger(aged)
  await ensureLedger(member)
}, 120_000)

afterAll(async () => {
  for (const id of [aged, fresh, member, legacy]) {
    await adminDb().delete(user).where(eq(user.id, id))
  }
  await closeDb()
})

describe('reap', () => {
  it('deletes an aged anonymous visitor and their whole ledger with them', async () => {
    expect((await searchTransactions(aged, { limit: 5 })).length).toBeGreaterThan(0)

    const result = await reap()
    expect(result.anonymousUsers).toBeGreaterThanOrEqual(1)

    expect(await userExists(aged)).toBe(false)
    // The cascade on owner_id is the entire implementation of "their ledger
    // goes too". Nothing here lists the tables, so nothing here can go stale.
    expect(await searchTransactions(aged, { limit: 5 })).toEqual([])
  }, 60_000)

  it('leaves a fresh anonymous visitor alone', async () => {
    expect(await userExists(fresh)).toBe(true)
  })

  it('leaves a signed-in visitor alone at any age', async () => {
    expect(await userExists(member)).toBe(true)
    expect((await searchTransactions(member, { limit: 5 })).length).toBeGreaterThan(0)
  })

  it('leaves a user whose is_anonymous was never set', async () => {
    // The column is nullable. Reaping on "not false" rather than "is true"
    // would delete a real account that predates the plugin's default.
    expect(await userExists(legacy)).toBe(true)
  })

  it('clears an abandoned confirmation belonging to a signed-in visitor', async () => {
    // These cascade away with an anonymous owner. A signed-in visitor who
    // closed the tab on a confirmation card leaves one behind forever.
    const conversation = await createConversation(member)
    await saveSuspendedTurn(
      member,
      conversation.id,
      {
        runId: '33333333-3333-4333-8333-333333333333',
        history: [],
        completedResults: [],
        pending: [],
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, thoughtTokens: 0 },
        costUsdEst: 0,
        iterations: 0,
      },
      { ttlMs: -1 },
    )

    expect((await reap()).suspendedTurns).toBeGreaterThanOrEqual(1)
  })

  it("clears yesterday's rate-limit counters", async () => {
    // rate_limits is the one table with no owner_id, which is deliberate — and
    // means nothing but this sweep will ever delete a row from it.
    await adminDb()
      .insert(rateLimits)
      .values({ key: 'reaper-probe-old', windowStart: '2020-01-01', count: 3 })
      .onConflictDoNothing()
    await adminDb()
      .insert(rateLimits)
      .values({
        key: 'reaper-probe-today',
        windowStart: new Date().toISOString().slice(0, 10),
        count: 1,
      })
      .onConflictDoNothing()

    expect((await reap()).rateLimits).toBeGreaterThanOrEqual(1)

    const remaining = await adminDb()
      .select({ key: rateLimits.key })
      .from(rateLimits)
      .where(eq(rateLimits.key, 'reaper-probe-today'))
    expect(remaining).toHaveLength(1)

    await adminDb().delete(rateLimits).where(eq(rateLimits.key, 'reaper-probe-today'))
  })
})
