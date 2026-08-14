import { describe, expect, it } from 'vitest'
import { decisionsFor, groupBySuspendedTurn } from './confirm'

/**
 * The case that matters is a batch of two, because a batch of one was always
 * right and is what every manual pass happened to produce. `runTurn` suspends
 * on the whole batch and declines by omission, so "answered one of them" and
 * "declined the other without asking" were the same click.
 */

const write = (id: string, suspendedTurnId: string) => ({ id, suspendedTurnId })

describe('groupBySuspendedTurn', () => {
  it('keeps every write of one suspended turn in a single decision', () => {
    const groups = groupBySuspendedTurn([write('w1', 'turn-a'), write('w2', 'turn-a')])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.writes.map((w) => w.id)).toEqual(['w1', 'w2'])
  })

  it('does not merge a later suspended turn into an earlier one', () => {
    const groups = groupBySuspendedTurn([
      write('w1', 'turn-a'),
      write('w2', 'turn-b'),
      write('w3', 'turn-a'),
    ])

    expect(groups.map((g) => g.suspendedTurnId)).toEqual(['turn-a', 'turn-b'])
    expect(groups[0]?.writes.map((w) => w.id)).toEqual(['w1', 'w3'])
    expect(groups[1]?.writes.map((w) => w.id)).toEqual(['w2'])
  })

  it('is empty for a turn that proposed nothing', () => {
    expect(groupBySuspendedTurn([])).toEqual([])
  })
})

describe('decisionsFor', () => {
  it('answers for every write in the batch, not just the one clicked', () => {
    // The regression. A single-element body meant runTurn matched w2 by id,
    // failed, and ran the decline branch on a write nobody was shown.
    expect(decisionsFor([write('w1', 'turn-a'), write('w2', 'turn-a')], true)).toEqual([
      { id: 'w1', allowed: true },
      { id: 'w2', allowed: true },
    ])
  })

  it('declines the whole batch together', () => {
    expect(decisionsFor([write('w1', 'turn-a'), write('w2', 'turn-a')], false)).toEqual([
      { id: 'w1', allowed: false },
      { id: 'w2', allowed: false },
    ])
  })
})
