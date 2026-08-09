import { describe, expect, it } from 'vitest'
import { isWritePending, type SuspendedState } from './suspend'

describe('suspend vocabulary', () => {
  it('recognises a state that is waiting on a decision', () => {
    const state: SuspendedState = {
      runId: '11111111-1111-4111-8111-111111111111',
      history: [],
      completedResults: [],
      pending: [{ id: 'call_0_set_budget', tool: 'set_budget', args: {}, summary: 'set a budget' }],
      usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 0, thoughtTokens: 0 },
      costUsdEst: 0.0001,
      iterations: 1,
    }
    expect(isWritePending(state)).toBe(true)
  })

  it('does not treat an empty pending list as waiting', () => {
    const state: SuspendedState = {
      runId: '11111111-1111-4111-8111-111111111111',
      history: [],
      completedResults: [],
      pending: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, thoughtTokens: 0 },
      costUsdEst: 0,
      iterations: 0,
    }
    expect(isWritePending(state)).toBe(false)
  })
})
