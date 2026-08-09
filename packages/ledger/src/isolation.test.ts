import { loadEnv } from '@kakeibo/core/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toCsv } from './csv'
import { closeDb } from './db'
import { commitImport, planImport } from './import'
import { minorToDecimalString } from './money'
import { asOwnerId, type OwnerId } from './owner'
import { accountBalances, ensureSeedAccounts, listAccounts } from './repo/accounts'
import {
  appendMessages,
  createConversation,
  latestConversation,
  loadHistory,
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

beforeAll(async () => {
  await resetOwners(alice, bob)
  await seedLedger(alice)

  const conversation = await createConversation(alice, 'Alice thinking aloud')
  aliceConversation = conversation.id
  await appendMessages(alice, aliceConversation, [
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

  it('gives Bob his own accounts but with zero balances', async () => {
    const accounts = await listAccounts(bob)
    expect(accounts.length).toBeGreaterThan(0)

    const balances = await accountBalances(bob)
    expect(balances.every((b) => b.balanceMinor === 0 && b.postingCount === 0)).toBe(true)
  })
})
