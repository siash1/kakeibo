import { loadEnv } from '@kakeibo/core/env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../db'
import { asOwnerId } from '../owner'
import { resetOwners } from '../testing'
import { DbTracer, getRun, listRuns } from './tracer'

loadEnv()

const owner = asOwnerId('00000000-0000-4000-8000-0000000ac001')

beforeAll(async () => {
  await resetOwners(owner)
}, 60_000)

afterAll(async () => {
  await closeDb()
})

describe('resuming a run', () => {
  it('continues the same trace rather than starting a second', async () => {
    const tracer = new DbTracer(owner)
    const run = await tracer.startRun({ provider: 'gemini', model: 'test', channel: 'web' })
    await run.event({ type: 'model_call', payload: { iteration: 0 } })

    const resumed = await tracer.resumeRun(run.id)
    await resumed.event({ type: 'tool_call', payload: { name: 'set_budget' } })
    await resumed.finish({
      status: 'ok',
      usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0, thoughtTokens: 0 },
      costUsdEst: 0.001,
      latencyMs: 500,
    })

    expect(resumed.id).toBe(run.id)
    expect(await listRuns(owner, 50)).toHaveLength(1)

    const detail = await getRun(owner, run.id)
    // Sequence numbers must continue, not restart: two events at seq 0 would
    // sort ambiguously and the timeline would render out of order.
    expect(detail?.events.map((e) => e.seq)).toEqual([0, 1])
    expect(detail?.run.status).toBe('ok')
  })
})
