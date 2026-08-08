import { describe, expect, it } from 'vitest'
import { ContextManager, groupTurns } from './context'
import { ScriptedAdapter, textBlock, toolUseBlock } from './testing'
import { InMemoryTracer } from './trace'
import type { CanonicalMessage, ContentBlock, ToolDef } from './types'

/** Context management (spec 8.4). */

function userTurn(text: string): CanonicalMessage {
  return { role: 'user', content: [textBlock(text)] }
}

function assistantTurn(...content: ContentBlock[]): CanonicalMessage {
  return { role: 'assistant', content }
}

function toolResultTurn(id: string, name: string, content: string): CanonicalMessage {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, name, content }] }
}

/** One exchange that used a tool: user -> assistant(tool_use) -> results -> assistant(text). */
function toolExchange(question: string, n: number): CanonicalMessage[] {
  return [
    userTurn(question),
    assistantTurn(toolUseBlock(`c${n}`, 'echo', { value: n })),
    toolResultTurn(`c${n}`, 'echo', `result ${n}`),
    assistantTurn(textBlock(`answer ${n}`)),
  ]
}

const noTools: ToolDef[] = []

describe('groupTurns', () => {
  it('keeps a tool call and its results inside one group', () => {
    const groups = groupTurns([...toolExchange('q1', 1), ...toolExchange('q2', 2)])
    expect(groups).toHaveLength(2)
    expect(groups[0]?.messages).toHaveLength(4)
    expect(groups[1]?.messages).toHaveLength(4)
  })

  it('starts a new group only at a real user turn, not at a tool result', () => {
    const groups = groupTurns([
      userTurn('q'),
      assistantTurn(toolUseBlock('a', 'echo', {}), toolUseBlock('b', 'echo', {})),
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', name: 'echo', content: '1' },
          { type: 'tool_result', tool_use_id: 'b', name: 'echo', content: '2' },
        ],
      },
      assistantTurn(textBlock('done')),
    ])
    expect(groups).toHaveLength(1)
  })
})

describe('ContextManager.fit', () => {
  const options = (adapter: ScriptedAdapter, budgetTokens: number) => ({
    system: 'sys',
    tools: noTools,
    adapter,
    model: 'scripted',
    summarizerModel: 'scripted',
    budgetTokens,
  })

  it('leaves history alone when it fits', async () => {
    const adapter = new ScriptedAdapter([])
    const history = [...toolExchange('q1', 1)]
    const result = await new ContextManager().fit(history, options(adapter, 100_000))

    expect(result.evicted).toBe(false)
    expect(result.messages).toBe(history)
    expect(adapter.callCount).toBe(0) // no summariser call
  })

  it('evicts oldest turns, summarises them, and pins the summary first', async () => {
    const adapter = new ScriptedAdapter([
      { content: [textBlock('Earlier: the user asked about q1 and q2.')] },
    ])
    const history = Array.from({ length: 10 }, (_, i) => toolExchange(`question ${i}`, i)).flat()

    const result = await new ContextManager().fit(history, options(adapter, 200))

    expect(result.evicted).toBe(true)
    expect(result.evictedTurns).toBe(4) // 10 groups - 6 kept
    expect(result.summary).toContain('Earlier:')

    // The summary is the first user turn, acknowledged by a stub assistant turn.
    const first = result.messages[0]
    expect(first?.role).toBe('user')
    expect((first?.content[0] as { text: string } | undefined)?.text).toContain('<context_summary>')
    expect(result.messages[1]).toMatchObject({ role: 'assistant' })
    expect((result.messages[1]?.content[0] as { text: string } | undefined)?.text).toBe(
      'Understood.',
    )
  })

  it('never splits a tool call from its results when evicting', async () => {
    const adapter = new ScriptedAdapter([{ content: [textBlock('summary')] }])
    const history = Array.from({ length: 10 }, (_, i) => toolExchange(`question ${i}`, i)).flat()

    const result = await new ContextManager().fit(history, options(adapter, 200))

    // Every tool_use id that survives must have a matching tool_result, and
    // every tool_result must have a matching tool_use. An unpaired one is a
    // guaranteed HTTP 400 from the provider.
    const uses = new Set<string>()
    const results = new Set<string>()
    for (const message of result.messages) {
      for (const block of message.content) {
        if (block.type === 'tool_use') uses.add(block.id)
        if (block.type === 'tool_result') results.add(block.tool_use_id)
      }
    }
    expect([...uses].sort()).toEqual([...results].sort())
  })

  it('keeps the six most recent turns intact', async () => {
    const adapter = new ScriptedAdapter([{ content: [textBlock('summary')] }])
    const history = Array.from({ length: 10 }, (_, i) => toolExchange(`question ${i}`, i)).flat()

    const result = await new ContextManager().fit(history, options(adapter, 200))
    const remaining = groupTurns(result.messages)

    // 1 pinned summary group + 6 kept turns.
    expect(remaining).toHaveLength(7)
    const texts = result.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
    expect(texts.some((t) => t.includes('question 9'))).toBe(true)
    expect(texts.some((t) => t.includes('question 4'))).toBe(true)
    expect(texts.some((t) => t.includes('question 0'))).toBe(false)
  })

  it('merges into the existing summary on a second eviction rather than stacking them', async () => {
    const manager = new ContextManager()
    const first = new ScriptedAdapter([{ content: [textBlock('Summary one.')] }])
    const history = Array.from({ length: 10 }, (_, i) => toolExchange(`question ${i}`, i)).flat()
    const once = await manager.fit(history, options(first, 200))

    const grown = [
      ...once.messages,
      ...Array.from({ length: 6 }, (_, i) => toolExchange(`later ${i}`, 100 + i)).flat(),
    ]
    const second = new ScriptedAdapter([{ content: [textBlock('Merged summary.')] }])
    const twice = await manager.fit(grown, options(second, 200))

    const summaries = twice.messages.filter(
      (m) =>
        m.role === 'user' &&
        m.content.some((b) => b.type === 'text' && b.text.includes('<context_summary>')),
    )
    expect(summaries).toHaveLength(1)
    // The summariser was shown the previous summary so it could fold it in.
    const prompt =
      (second.requests[0]?.messages[0]?.content[0] as { text: string } | undefined)?.text ?? ''
    expect(prompt).toContain('EXISTING SUMMARY')
    expect(prompt).toContain('Summary one.')
  })

  it('traces the eviction with before/after token counts', async () => {
    const adapter = new ScriptedAdapter([{ content: [textBlock('summary')] }])
    const tracer = new InMemoryTracer()
    const run = await tracer.startRun({ provider: 'scripted', model: 'scripted', channel: 'eval' })
    const history = Array.from({ length: 10 }, (_, i) => toolExchange(`question ${i}`, i)).flat()

    await new ContextManager().fit(history, { ...options(adapter, 200), trace: run })

    const events = tracer.eventsOfType('summary_eviction')
    expect(events).toHaveLength(1)
    const payload = events[0]?.payload as { tokensBefore: number; tokensAfter: number }
    expect(payload.tokensBefore).toBeGreaterThan(payload.tokensAfter)
  })

  it('falls back to the previous summary if the summariser returns nothing', async () => {
    const adapter = new ScriptedAdapter([{ content: [] }])
    const history = Array.from({ length: 10 }, (_, i) => toolExchange(`question ${i}`, i)).flat()

    const result = await new ContextManager().fit(history, options(adapter, 200))
    expect(result.evicted).toBe(true)
    expect(result.summary).toContain('summary unavailable')
  })

  it('measures the chars/4 estimate against the real count', async () => {
    const adapter = new ScriptedAdapter([])
    const manager = new ContextManager()
    const history = [...toolExchange('q1', 1)]

    await manager.fit(history, options(adapter, 100_000))
    const error = manager.estimateError()

    expect(error).not.toBeNull()
    // The scripted counter is chars/4 over a slightly different payload, so the
    // error is small but non-trivial — the point is that it is a real number.
    expect(Math.abs(error!)).toBeLessThan(1)
  })
})
