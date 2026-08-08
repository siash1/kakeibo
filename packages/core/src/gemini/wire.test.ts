import { describe, expect, it } from 'vitest'
import type { CanonicalMessage, ToolUseBlock } from '../types'
import { fromWireParts, toWireContents, type WirePart } from './wire'

/**
 * Canonical <-> wire mapping (spec 8.1).
 *
 * These assertions encode three behaviours observed against the live API. Each
 * one, if broken, produces a runtime HTTP 400 rather than a type error, so they
 * are exactly the things worth pinning in a test.
 */

describe('fromWireParts', () => {
  it('uses the provider call id when Gemini 3.x supplies one', () => {
    const parts: WirePart[] = [
      { functionCall: { id: 'qqr4Ds1a', name: 'get_spend_report', args: { period: '2025-03' } } },
    ]
    const { toolUses } = fromWireParts(parts, 0)

    expect(toolUses[0]?.id).toBe('qqr4Ds1a')
    expect(toolUses[0]?.providerMeta?.providerCallId).toBe('qqr4Ds1a')
  })

  it('synthesises a correlation id when Gemini 2.5 supplies none', () => {
    const parts: WirePart[] = [{ functionCall: { name: 'get_spend_report', args: {} } }]
    const { toolUses } = fromWireParts(parts, 0)

    expect(toolUses[0]?.id).toBe('call_0_get_spend_report')
    expect(toolUses[0]?.providerMeta?.providerCallId).toBeUndefined()
  })

  it('keeps synthesised ids unique across several calls in one turn', () => {
    const parts: WirePart[] = [
      { functionCall: { name: 'echo', args: { i: 1 } } },
      { functionCall: { name: 'echo', args: { i: 2 } } },
    ]
    const { toolUses } = fromWireParts(parts, 0)
    expect(toolUses.map((u) => u.id)).toEqual(['call_0_echo', 'call_1_echo'])
  })

  it('captures the thought signature that only the first parallel call carries', () => {
    // Observed shape: with two parallel calls, Gemini attaches thoughtSignature
    // to the first part only.
    const parts: WirePart[] = [
      { functionCall: { id: 'a', name: 'echo', args: {} }, thoughtSignature: 'SIG-A' },
      { functionCall: { id: 'b', name: 'echo', args: {} } },
    ]
    const { toolUses } = fromWireParts(parts, 0)

    expect(toolUses[0]?.providerMeta?.thoughtSignature).toBe('SIG-A')
    expect(toolUses[1]?.providerMeta?.thoughtSignature).toBeUndefined()
  })

  it('separates thought summaries from answer text', () => {
    const parts: WirePart[] = [
      { text: 'Let me check the ledger.', thought: true },
      { text: 'You spent ₹100.' },
    ]
    const { content } = fromWireParts(parts, 0)

    expect(content[0]).toMatchObject({ type: 'thought_summary' })
    expect(content[1]).toMatchObject({ type: 'text', text: 'You spent ₹100.' })
  })
})

describe('toWireContents', () => {
  it('restores the thought signature — omitting it is a hard 400', () => {
    const message: CanonicalMessage = {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'a',
          name: 'echo',
          input: { x: 1 },
          providerMeta: { providerCallId: 'a', thoughtSignature: 'SIG-A' },
        } satisfies ToolUseBlock,
      ],
    }

    const [content] = toWireContents([message])
    expect(content?.role).toBe('model')
    expect(content?.parts[0]?.thoughtSignature).toBe('SIG-A')
    expect(content?.parts[0]?.functionCall?.id).toBe('a')
  })

  it('does not invent a call id the provider never issued', () => {
    // A synthesised id echoed back as functionCall.id makes pairing worse, not
    // better — the provider pairs by position when ids are absent.
    const message: CanonicalMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_0_echo', name: 'echo', input: {} }],
    }
    const [content] = toWireContents([message])
    expect(content?.parts[0]?.functionCall?.id).toBeUndefined()
  })

  it('wraps tool results in a struct, which the API requires', () => {
    const message: CanonicalMessage = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'a', name: 'echo', content: 'plain string' }],
    }
    const [content] = toWireContents([message])

    expect(content?.role).toBe('user')
    expect(content?.parts[0]?.functionResponse?.response).toEqual({ result: 'plain string' })
  })

  it('marks an error result distinctly so the model can tell failure from data', () => {
    const message: CanonicalMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', name: 'echo', content: 'boom', is_error: true },
      ],
    }
    const [content] = toWireContents([message])
    expect(content?.parts[0]?.functionResponse?.response).toEqual({ error: 'boom' })
  })

  it('emits one functionResponse per functionCall, in order', () => {
    // The provider rejects a turn where these counts differ. This is the
    // wire-level reason spec 8.3h insists on a single results message.
    const history: CanonicalMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'a',
            name: 'echo',
            input: {},
            providerMeta: { providerCallId: 'a' },
          },
          {
            type: 'tool_use',
            id: 'b',
            name: 'echo',
            input: {},
            providerMeta: { providerCallId: 'b' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', name: 'echo', content: '1' },
          { type: 'tool_result', tool_use_id: 'b', name: 'echo', content: '2' },
        ],
      },
    ]

    const wire = toWireContents(history)
    const calls = wire[0]?.parts.filter((p) => p.functionCall).length
    const responses = wire[1]?.parts.filter((p) => p.functionResponse).length
    expect(calls).toBe(responses)
    expect(wire[1]?.parts.map((p) => p.functionResponse?.id)).toEqual(['a', 'b'])
  })

  it('drops thought summaries: the signature is what the model needs back, not the prose', () => {
    const message: CanonicalMessage = {
      role: 'assistant',
      content: [
        { type: 'thought_summary', text: 'thinking out loud' },
        { type: 'text', text: 'the answer' },
      ],
    }
    const [content] = toWireContents([message])
    expect(content?.parts).toHaveLength(1)
    expect(content?.parts[0]?.text).toBe('the answer')
  })

  it('survives a full round trip', () => {
    const parts: WirePart[] = [
      {
        functionCall: { id: 'x1', name: 'get_spend_report', args: { period: '2025-03' } },
        thoughtSignature: 'SIG',
      },
    ]
    const { content } = fromWireParts(parts, 0)
    const [wire] = toWireContents([{ role: 'assistant', content }])

    expect(wire?.parts[0]?.functionCall).toEqual({
      id: 'x1',
      name: 'get_spend_report',
      args: { period: '2025-03' },
    })
    expect(wire?.parts[0]?.thoughtSignature).toBe('SIG')
  })
})
