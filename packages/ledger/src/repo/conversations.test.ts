import { loadEnv } from '@kakeibo/core/env'
import type { CanonicalMessage } from '@kakeibo/core/types'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../db'
import { asOwnerId } from '../owner'
import { resetOwners } from '../testing'
import {
  createConversation,
  latestConversation,
  loadHistory,
  replaceHistory,
  saveSuspendedTurn,
  takeSuspendedTurn,
} from './conversations'

loadEnv()

const owner = asOwnerId('00000000-0000-4000-8000-00000000cc01')
const other = asOwnerId('00000000-0000-4000-8000-00000000cc02')

beforeAll(async () => {
  await resetOwners(owner, other)
}, 60_000)

afterAll(async () => {
  await closeDb()
})

const toolTurn: CanonicalMessage = {
  role: 'assistant',
  content: [
    {
      type: 'tool_use',
      id: 'x1',
      name: 'get_spend_report',
      input: { period: '2025-03' },
      providerMeta: { providerCallId: 'x1', thoughtSignature: 'SIG-ABC' },
    },
  ],
}

describe('conversation history', () => {
  it('round-trips providerMeta, including the thought signature', async () => {
    const conversation = await createConversation(owner)
    await replaceHistory(owner, conversation.id, [toolTurn])

    const history = await loadHistory(owner, conversation.id)
    const block = history[0]?.content[0]
    // Losing this is a hard 400 on the next request, and only on tool turns —
    // so a persistence layer that "cleans up" the message shape breaks in
    // production and passes every test that does not look for it.
    expect((block as { providerMeta?: Record<string, unknown> }).providerMeta).toEqual({
      providerCallId: 'x1',
      thoughtSignature: 'SIG-ABC',
    })
    expect(history).toEqual([toolTurn])
  })

  it('keeps messages in the order they were written', async () => {
    const conversation = await createConversation(owner)
    await replaceHistory(owner, conversation.id, [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'text', text: 'three' }] },
    ])

    const history = await loadHistory(owner, conversation.id)
    expect(history.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'one',
      'two',
      'three',
    ])
  })

  it('lets a summarised window replace the messages it evicted', async () => {
    // The reason this replaces rather than appends. When the window fills, the
    // context manager swaps a run of older messages for one summary; an
    // append-only table would keep feeding the model messages it no longer
    // reasons over, and the stored history would stop matching the live one.
    const conversation = await createConversation(owner)
    await replaceHistory(owner, conversation.id, [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'text', text: 'three' }] },
    ])
    await replaceHistory(owner, conversation.id, [
      { role: 'user', content: [{ type: 'text', text: 'summary of one and two' }] },
      { role: 'user', content: [{ type: 'text', text: 'three' }] },
    ])

    const history = await loadHistory(owner, conversation.id)
    expect(history.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'summary of one and two',
      'three',
    ])
  })

  it('will not load another owner conversation', async () => {
    const mine = await createConversation(owner)
    await replaceHistory(owner, mine.id, [{ role: 'user', content: [{ type: 'text', text: 'x' }] }])
    expect(await loadHistory(other, mine.id)).toEqual([])
  })

  it('finds the most recently updated conversation, per owner', async () => {
    const theirs = await createConversation(other)
    expect((await latestConversation(other))?.id).toBe(theirs.id)
    // The owner's own newest, not the one that happens to be newest globally.
    const mine = await createConversation(owner)
    expect((await latestConversation(owner))?.id).toBe(mine.id)
  })
})

describe('suspended turns', () => {
  const state = {
    runId: '11111111-1111-4111-8111-111111111111',
    history: [toolTurn],
    completedResults: [
      { type: 'tool_result' as const, tool_use_id: 'r1', name: 'lookup', content: 'ok' },
    ],
    pending: [{ id: 'w1', tool: 'set_budget', args: { amount: 5 }, summary: 'set a budget' }],
    usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0, thoughtTokens: 0 },
    costUsdEst: 0.000123,
    iterations: 1,
  }

  it('returns the state once and never again', async () => {
    const conversation = await createConversation(owner)
    const id = await saveSuspendedTurn(owner, conversation.id, state)

    const taken = await takeSuspendedTurn(owner, id)
    expect(taken?.state).toEqual(state)
    expect(taken?.conversationId).toBe(conversation.id)

    // Deleting as it reads is what stops a replayed decision running the same
    // write twice. Answering the same card again must find nothing.
    expect(await takeSuspendedTurn(owner, id)).toBeUndefined()
  })

  it('carries the spend from before the pause without rounding it away', async () => {
    const conversation = await createConversation(owner)
    const id = await saveSuspendedTurn(owner, conversation.id, state)
    const taken = await takeSuspendedTurn(owner, id)
    // numeric(10,6) exactly: a turn costing fractions of a cent still has to
    // count against the daily cap.
    expect(taken?.state.costUsdEst).toBe(0.000123)
    expect(taken?.state.usage).toEqual(state.usage)
  })

  it('will not hand another owner suspended turn over', async () => {
    const conversation = await createConversation(owner)
    const id = await saveSuspendedTurn(owner, conversation.id, state)
    expect(await takeSuspendedTurn(other, id)).toBeUndefined()
    // And it is still there for its rightful owner.
    expect(await takeSuspendedTurn(owner, id)).toBeDefined()
  })

  it('refuses an expired turn and clears it', async () => {
    const conversation = await createConversation(owner)
    const id = await saveSuspendedTurn(owner, conversation.id, state, { ttlMs: -1 })
    expect(await takeSuspendedTurn(owner, id)).toBeUndefined()
  })
})
