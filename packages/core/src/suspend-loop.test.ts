import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runTurn } from './loop'
import { ToolRegistry, type ToolSpec } from './registry'
import { ScriptedAdapter, textBlock, toolUseBlock } from './testing'
import { InMemoryTracer } from './trace'
import type { CanonicalMessage } from './types'

/**
 * Suspend and resume (spec §6): the path that makes the confirm-before-write
 * gate work on serverless, where the decider is a browser on the far side of a
 * second HTTP request rather than a callback in this process.
 */

const readTool: ToolSpec<{ value: string }> = {
  name: 'lookup',
  tier: 'read',
  description: 'Reads something',
  input: z.object({ value: z.string() }),
  handler: async (input) => ({ looked_up: input.value }),
}

const writeTool: ToolSpec<{ amount: number }> = {
  name: 'set_thing',
  tier: 'write',
  description: 'Writes a thing',
  input: z.object({ amount: z.number() }),
  summarize: (input) => `set the thing to ${input.amount}`,
  handler: async (input) => ({ written: input.amount }),
}

function registry(): ToolRegistry {
  return new ToolRegistry().registerAll([readTool, writeTool] as unknown as ToolSpec<unknown>[])
}

const base = {
  history: [] as CanonicalMessage[],
  model: 'scripted',
  summarizerModel: 'scripted',
  channel: 'web' as const,
  system: 'test system prompt',
}

describe('suspend', () => {
  it('stops at a write and hands back what it was about to do', async () => {
    const adapter = new ScriptedAdapter([
      { content: [toolUseBlock('c1', 'set_thing', { amount: 5 })] },
    ])

    const result = await runTurn({
      ...base,
      userMessage: 'set it to 5',
      adapter,
      registry: registry(),
      tracer: new InMemoryTracer(),
      confirmPolicy: { mode: 'suspend' },
    })

    expect(result.status).toBe('suspended')
    expect(result.suspended?.pending).toHaveLength(1)
    expect(result.suspended?.pending[0]).toMatchObject({
      id: 'c1',
      tool: 'set_thing',
      summary: 'set the thing to 5',
    })
    // The tool must NOT have run.
    expect(result.toolCalls.filter((c) => c.name === 'set_thing' && c.confirmed)).toEqual([])
    // Spend before the pause is carried, or the resumed turn under-reports it.
    expect(result.suspended?.usage.inputTokens).toBeGreaterThan(0)
  })

  it('runs the reads in a mixed batch and carries their results', async () => {
    // The provider requires response count to equal call count, so a batch
    // cannot be answered piecemeal. Reads execute now, writes wait, and the
    // read results are carried so resume does not run them twice.
    const adapter = new ScriptedAdapter([
      {
        content: [
          toolUseBlock('r1', 'lookup', { value: 'a' }),
          toolUseBlock('w1', 'set_thing', { amount: 1 }),
          toolUseBlock('w2', 'set_thing', { amount: 2 }),
        ],
      },
    ])

    const result = await runTurn({
      ...base,
      userMessage: 'do three things',
      adapter,
      registry: registry(),
      tracer: new InMemoryTracer(),
      confirmPolicy: { mode: 'suspend' },
    })

    expect(result.status).toBe('suspended')
    expect(result.suspended?.pending.map((p) => p.id)).toEqual(['w1', 'w2'])
    expect(result.suspended?.completedResults).toHaveLength(1)
    expect(result.suspended?.completedResults[0]?.tool_use_id).toBe('r1')
  })

  it('does not suspend when there is no write', async () => {
    const adapter = new ScriptedAdapter([
      { content: [toolUseBlock('r1', 'lookup', { value: 'a' })] },
      { content: [textBlock('Found it.')] },
    ])

    const result = await runTurn({
      ...base,
      userMessage: 'look it up',
      adapter,
      registry: registry(),
      tracer: new InMemoryTracer(),
      confirmPolicy: { mode: 'suspend' },
    })

    expect(result.status).toBe('ok')
    expect(result.text).toBe('Found it.')
  })
})

describe('resume', () => {
  it('runs approved writes, refuses the rest, and answers the batch in one message', async () => {
    const first = new ScriptedAdapter([
      {
        content: [
          toolUseBlock('r1', 'lookup', { value: 'a' }),
          toolUseBlock('w1', 'set_thing', { amount: 1 }),
          toolUseBlock('w2', 'set_thing', { amount: 2 }),
        ],
      },
    ])
    const tracer = new InMemoryTracer()
    const suspended = await runTurn({
      ...base,
      userMessage: 'do three things',
      adapter: first,
      registry: registry(),
      tracer,
      confirmPolicy: { mode: 'suspend' },
    })

    const second = new ScriptedAdapter([{ content: [textBlock('Did one of them.')] }])
    const result = await runTurn({
      ...base,
      userMessage: '',
      adapter: second,
      registry: registry(),
      tracer,
      confirmPolicy: { mode: 'suspend' },
      resume: {
        state: suspended.suspended!,
        decisions: [
          { id: 'w1', allowed: true },
          { id: 'w2', allowed: false },
        ],
      },
    })

    expect(result.status).toBe('ok')
    expect(result.text).toBe('Did one of them.')

    // All three results, in one message, in call order. Any other shape is a
    // hard 400 from the provider.
    const answered = second.requests[0]?.messages.at(-1)
    expect(answered?.role).toBe('user')
    const results = (answered?.content ?? []).filter((b) => b.type === 'tool_result')
    expect(results.map((b) => (b as { tool_use_id: string }).tool_use_id)).toEqual([
      'r1',
      'w1',
      'w2',
    ])
    expect((results[2] as { content: string }).content).toContain('User declined')

    // One trace, and the pre-pause spend is included.
    expect(result.runId).toBe(suspended.runId)
    expect(result.usage.inputTokens).toBeGreaterThan(suspended.suspended!.usage.inputTokens)

    // Exactly two confirm events for two proposed writes: one recorded when the
    // turn paused, one when it was answered. A third would mean the resume path
    // and executeToolUse each recorded the same decision, which doubles every
    // "writes allowed" figure computed from the timeline.
    const confirms = tracer.runs[0]!.events.filter((e) => e.type === 'confirm')
    expect(confirms).toHaveLength(4)
    expect(confirms.map((e) => (e.payload as { allowed: boolean | null }).allowed)).toEqual([
      null,
      null,
      true,
      false,
    ])
  })
})
