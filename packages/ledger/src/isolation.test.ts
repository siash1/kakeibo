import { loadEnv } from '@kakeibo/core/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toCsv } from './csv'
import { closeDb } from './db'
import { commitImport, planImport } from './import'
import { minorToDecimalString } from './money'
import { asOwnerId, type OwnerId } from './owner'
import { accountBalances, ensureSeedAccounts, listAccounts } from './repo/accounts'
import {
  createConversation,
  latestConversation,
  loadHistory,
  replaceHistory,
  saveSuspendedTurn,
  takeSuspendedTurn,
} from './repo/conversations'
import {
  budgetStatus,
  detectRecurring,
  flagAnomalies,
  monthToPeriod,
  spendReport,
} from './repo/reports'
import { cacheStats, DbTracer, getRun, listRuns } from './repo/tracer'
import { searchTransactions } from './repo/transactions'
import { listBudgets, listRules } from './repo/writes'
import { generateSeedData } from './seed/generate'
import { resetOwners } from './testing'

/**
 * The systematic cross-tenant isolation suite — the proof of success
 * criterion 2, that no visitor can ever observe another visitor's data.
 *
 * Tasks 4-7 each tested their own module. This one seeds two complete ledgers
 * and asserts that every read function returns only its own owner's rows.
 *
 * Table-driven so that adding a repository read without adding it here is
 * visible in review. Any failure in this file is a real leak, not a flaky
 * test — fix the repository function, never the assertion.
 *
 * THIS SUITE MUST RUN TWICE, and `pnpm test` does exactly that:
 *
 *   1. normally, as `app_user`, with row-level security enforcing;
 *   2. with APP_DATABASE_URL cleared, as the owning role, where RLS is bypassed.
 *
 * The second pass is the one that actually tests the application. Verified by
 * mutation: deleting the owner filter from searchTransactions leaves pass (1)
 * completely green, because RLS silently covers the mistake. Only pass (2)
 * fails. Without it, every `where owner_id = ...` in the repository could be
 * removed and CI would not notice — leaving the system resting on RLS alone,
 * which breaks the first time it meets a database where the policies were
 * never applied.
 */

loadEnv()

const alice = asOwnerId('00000000-0000-4000-8000-00000000f111')
const bob = asOwnerId('00000000-0000-4000-8000-00000000f222')
const seed = generateSeedData()

async function seedLedger(owner: OwnerId): Promise<void> {
  await ensureSeedAccounts(owner)
  const csv = toCsv(
    seed.rows.map((row) => ({
      date: row.date,
      description: row.description,
      amount: minorToDecimalString(row.amountMinor),
      category: row.csvCategory,
    })),
    ['date', 'description', 'amount', 'category'],
  )
  const { preview, resolved } = await planImport(owner, 'iso.csv', csv, 'sample')
  await commitImport(owner, 'iso.csv', resolved, preview)
}

/** Alice's, so Bob can be asked for them by id and must still get nothing. */
let aliceConversation = ''
let aliceSuspendedTurn = ''
let aliceRun = ''

beforeAll(async () => {
  await resetOwners(alice, bob)
  await seedLedger(alice)

  const conversation = await createConversation(alice, 'Alice thinking aloud')
  aliceConversation = conversation.id
  await replaceHistory(alice, aliceConversation, [
    { role: 'user', content: [{ type: 'text', text: 'what did I spend on groceries?' }] },
  ])
  aliceSuspendedTurn = await saveSuspendedTurn(alice, aliceConversation, {
    runId: '22222222-2222-4222-8222-222222222222',
    history: [],
    completedResults: [],
    pending: [{ id: 'w1', tool: 'set_budget', args: {}, summary: 'set a budget' }],
    usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 0, thoughtTokens: 0 },
    costUsdEst: 0.0001,
    iterations: 1,
  })

  /*
   * One finished, traced run of Alice's.
   *
   * A trace is the most sensitive thing an owner has that is not the ledger
   * itself: design spec §9.6 notes that trace payloads carry tool arguments and
   * results, so reading someone's trace is reading their ledger contents by
   * another route. The tokens are non-zero so `cacheStats` has something real to
   * report and Bob's zeroes mean "none of Alice's" rather than "no data yet".
   */
  const run = await new DbTracer(alice).startRun({
    provider: 'gemini',
    model: 'test',
    channel: 'web',
  })
  aliceRun = run.id
  await run.event({ type: 'tool_call', payload: { name: 'search_transactions' } })
  await run.finish({
    status: 'ok',
    usage: { inputTokens: 1000, outputTokens: 100, cachedTokens: 800, thoughtTokens: 0 },
    costUsdEst: 0.001,
    latencyMs: 1200,
  })

  // Bob gets accounts but NO transactions. Every read below must therefore
  // come back empty for him — a far sharper assertion than "different", which
  // an off-by-one scoping bug could still satisfy.
  await ensureSeedAccounts(bob)
}, 180_000)

afterAll(async () => {
  await closeDb()
})

describe('cross-tenant isolation', () => {
  it('gives Alice a full ledger', async () => {
    expect((await searchTransactions(alice, { limit: 500 })).length).toBeGreaterThan(300)
  })

  const emptyForBob: [string, (owner: OwnerId) => Promise<unknown[]>][] = [
    ['searchTransactions', (o) => searchTransactions(o, { limit: 500 })],
    ['spendReport', (o) => spendReport(o, monthToPeriod('2025-03'), 'category')],
    ['detectRecurring', (o) => detectRecurring(o, 3)],
    ['flagAnomalies', (o) => flagAnomalies(o, '2025-04')],
    ['budgetStatus', (o) => budgetStatus(o, '2025-03')],
    ['listRules', (o) => listRules(o)],
    ['listBudgets', (o) => listBudgets(o)],
    // Given Alice's conversation id outright. Guessing an id is not the threat
    // model — being handed one is.
    ['loadHistory', (o) => loadHistory(o, aliceConversation)],
    ['listRuns', (o) => listRuns(o)],
  ]

  for (const [name, read] of emptyForBob) {
    it(`${name} returns nothing of Alice's to Bob`, async () => {
      expect(await read(bob)).toEqual([])
    })
  }

  it('does not offer Bob Alice as his latest conversation', async () => {
    expect(await latestConversation(bob)).toBeUndefined()
    expect((await latestConversation(alice))?.id).toBe(aliceConversation)
  })

  it('does not let Bob answer a confirmation waiting on Alice', async () => {
    // The sharpest one here: a suspended turn holds a write the loop will run
    // on resume. Taking someone else's would be executing a write in their
    // ledger, not merely reading it.
    expect(await takeSuspendedTurn(bob, aliceSuspendedTurn)).toBeUndefined()
    expect(await takeSuspendedTurn(alice, aliceSuspendedTurn)).toBeDefined()
  })

  it('does not hand Bob the trace of Alice, even given its id', async () => {
    // Handed the id outright, as with the conversation above. `getRun`
    // returning undefined rather than throwing is what lets the trace viewer
    // 404 instead of confirming that the run exists at all.
    expect(await getRun(bob, aliceRun)).toBeUndefined()
    expect((await getRun(alice, aliceRun))?.run.id).toBe(aliceRun)
  })

  it('does not count runs of Alice in the cache statistics of Bob', async () => {
    // An aggregate leaks differently from a row: nothing of Alice's is shown,
    // but an unscoped SUM would still tell Bob how much traffic the site has.
    expect(await cacheStats(bob)).toEqual({
      runs: 0,
      inputTokens: 0,
      cachedTokens: 0,
      savingsPercent: 0,
    })

    const mine = await cacheStats(alice)
    expect(mine.runs).toBe(1)
    expect(mine.inputTokens).toBe(1000)
    expect(mine.cachedTokens).toBe(800)
  })

  it('gives Bob his own accounts but with zero balances', async () => {
    const accounts = await listAccounts(bob)
    expect(accounts.length).toBeGreaterThan(0)

    const balances = await accountBalances(bob)
    expect(balances.every((b) => b.balanceMinor === 0 && b.postingCount === 0)).toBe(true)
  })
})
