import { loadEnv, resetEnvCache } from '@kakeibo/core/env'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { user } from '../auth-schema'
import { adminDb, closeDb } from '../db'
import { asOwnerId, type OwnerId } from '../owner'
import { resetOwners } from '../testing'
import { consumeQuota, hashIp, spendToday } from './quota'
import { DbTracer } from './tracer'

loadEnv()

const solo = asOwnerId('00000000-0000-4000-8000-00000000d001')
const chatty = asOwnerId('00000000-0000-4000-8000-00000000d002')
const banned = asOwnerId('00000000-0000-4000-8000-00000000d003')
const sharer = asOwnerId('00000000-0000-4000-8000-00000000d004')
const cotenant = asOwnerId('00000000-0000-4000-8000-00000000d005')

/** Records `count` finished turns for an owner, exactly as a real turn would. */
async function spend(owner: OwnerId, count: number, costUsd = 0): Promise<void> {
  const tracer = new DbTracer(owner)
  for (let i = 0; i < count; i++) {
    const run = await tracer.startRun({ provider: 'test', model: 'test', channel: 'web' })
    await run.finish({
      status: 'ok',
      usage: { inputTokens: 10, outputTokens: 1, cachedTokens: 0, thoughtTokens: 0 },
      costUsdEst: costUsd,
      latencyMs: 1,
    })
  }
}

function setBudget(usd: number): void {
  process.env.GLOBAL_DAILY_BUDGET_USD = String(usd)
  resetEnvCache()
}

async function setBlocked(owner: OwnerId, blocked: boolean): Promise<void> {
  await adminDb()
    .update(user)
    .set({ blockedAt: blocked ? new Date() : null })
    .where(eq(user.id, owner))
}

beforeAll(async () => {
  await resetOwners(solo, chatty, banned, sharer, cotenant)
  // The global cap reads every owner's spend, including whatever this developer
  // ran today. Lifting it out of the way keeps the first eight tests about the
  // layer each is actually testing; the last one lowers it deliberately.
  setBudget(1_000_000)
}, 60_000)

beforeEach(async () => {
  // The address counter is global by design, so each test wants its own keys.
  await adminDb().execute(`delete from rate_limits where key like 'test-%'`)
})

afterAll(async () => {
  // delete, not = undefined: assigning would leave the literal string
  // "undefined" in the environment and the next env() parse would reject it.
  delete process.env.GLOBAL_DAILY_BUDGET_USD
  resetEnvCache()
  await closeDb()
})

describe('consumeQuota', () => {
  it('allows a visitor who has spent nothing', async () => {
    const verdict = await consumeQuota({ owner: solo, isAnonymous: true, kind: 'message' })
    expect(verdict.allowed).toBe(true)
  })

  it('stops an anonymous visitor at the anonymous quota', async () => {
    await spend(chatty, 8)
    const verdict = await consumeQuota({ owner: chatty, isAnonymous: true, kind: 'message' })
    expect(verdict).toMatchObject({ allowed: false, reason: 'owner_quota' })
  })

  it('lets the same visitor through once they have an account', async () => {
    // The same eight turns against a signed-in quota of 25. Signing in is the
    // upgrade path the whole design offers, so it has to change the answer.
    const verdict = await consumeQuota({ owner: chatty, isAnonymous: false, kind: 'message' })
    expect(verdict.allowed).toBe(true)
  })

  it('counts a suspended turn once, not twice', async () => {
    // A turn that pauses for a confirmation writes one trace_runs row and
    // resumes into the same one. Counting naively would charge two messages for
    // one, and the cheapest way to burn a quota would be to ask for something
    // that needs approval — which is exactly backwards.
    const tracer = new DbTracer(solo)
    const run = await tracer.startRun({ provider: 'test', model: 'test', channel: 'web' })
    const resumed = await tracer.resumeRun(run.id)
    await resumed.finish({
      status: 'ok',
      usage: { inputTokens: 10, outputTokens: 1, cachedTokens: 0, thoughtTokens: 0 },
      costUsdEst: 0,
      latencyMs: 1,
    })

    const verdict = await consumeQuota({ owner: solo, isAnonymous: true, kind: 'message' })
    expect(verdict.allowed).toBe(true)
    if (verdict.allowed) expect(verdict.used.owner).toBe(1)
  })

  it('does not charge a resume against the message quota', async () => {
    // The message was paid for when the turn started. Charging again would make
    // it possible to be locked out of finishing a turn already in flight, with
    // a write left dangling and no way to answer for it.
    await spend(banned, 30)
    const verdict = await consumeQuota({ owner: banned, isAnonymous: false, kind: 'resume' })
    expect(verdict.allowed).toBe(true)
  })

  it('refuses a blocked owner before anything else', async () => {
    await setBlocked(banned, true)
    expect(
      await consumeQuota({ owner: banned, isAnonymous: false, kind: 'message' }),
    ).toMatchObject({ allowed: false, reason: 'blocked' })
    // Resumes too: blocking has to stop a turn already in flight, or the last
    // thing an abusive visitor did still lands in the ledger.
    expect(await consumeQuota({ owner: banned, isAnonymous: false, kind: 'resume' })).toMatchObject(
      {
        allowed: false,
        reason: 'blocked',
      },
    )
    await setBlocked(banned, false)
  })

  it('caps an address independently of the owner behind it', async () => {
    // Clearing cookies mints a fresh anonymous user, which resets the per-owner
    // quota. This layer exists precisely so that does not reset the budget.
    const ipHash = 'test-shared-address'
    for (let i = 0; i < 20; i++) {
      const verdict = await consumeQuota({
        owner: sharer,
        ipHash,
        isAnonymous: false,
        kind: 'message',
      })
      expect(verdict.allowed).toBe(true)
    }

    const verdict = await consumeQuota({
      owner: cotenant,
      ipHash,
      isAnonymous: true,
      kind: 'message',
    })
    expect(verdict).toMatchObject({ allowed: false, reason: 'ip_quota' })
  })

  it('does not charge the address for a message it refused', async () => {
    // The owner quota trips first, so the address must come away unmarked.
    // Otherwise one exhausted visitor slowly burns the shared cap down for
    // everyone else in their office.
    const ipHash = 'test-unspent-address'
    await spend(cotenant, 8)
    expect(
      await consumeQuota({ owner: cotenant, ipHash, isAnonymous: true, kind: 'message' }),
    ).toMatchObject({ allowed: false, reason: 'owner_quota' })

    const verdict = await consumeQuota({ owner: solo, ipHash, isAnonymous: true, kind: 'message' })
    expect(verdict.allowed).toBe(true)
    if (verdict.allowed) expect(verdict.used.ip).toBe(1)
  })

  it('stops everyone once the day costs more than the ceiling', async () => {
    // The layer that protects a personal card. Checked independently of the
    // other two, and it applies to resumes as well, because resuming makes
    // fresh model calls.
    // A tenth of a cent, not a realistic day's worth. The cap is relative to
    // the configured ceiling, and a test that left half a dollar of fake spend
    // behind would trip the real ceiling for the rest of the developer's day.
    const before = await spendToday()
    await spend(solo, 1, 0.001)
    expect(await spendToday()).toBeGreaterThan(before)
    setBudget(0.0000001)

    expect(await consumeQuota({ owner: solo, isAnonymous: true, kind: 'message' })).toMatchObject({
      allowed: false,
      reason: 'daily_cap',
    })
    expect(await consumeQuota({ owner: solo, isAnonymous: false, kind: 'resume' })).toMatchObject({
      allowed: false,
      reason: 'daily_cap',
    })
  })
})

describe('hashIp', () => {
  it('gives one address different keys on different days', () => {
    const today = hashIp('203.0.113.7', '2026-08-09')
    const tomorrow = hashIp('203.0.113.7', '2026-08-10')
    expect(today).not.toBe(tomorrow)
    // And never the address itself, which is the whole reason for hashing it.
    expect(today).not.toContain('203.0.113')
  })

  it('gives two addresses different keys on the same day', () => {
    expect(hashIp('203.0.113.7', '2026-08-09')).not.toBe(hashIp('203.0.113.8', '2026-08-09'))
  })
})
