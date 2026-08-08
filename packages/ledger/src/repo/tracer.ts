import { randomUUID } from 'node:crypto'
import type { Channel, RunFinish, TraceEventInput, TraceRunHandle, Tracer } from '@kakeibo/core'
import { desc, eq } from 'drizzle-orm'
import { getDb } from '../db'
import { traceEvents, traceRuns } from '../schema'

/**
 * Postgres-backed tracer (spec 8.7).
 *
 * Writes are awaited rather than fired and forgotten. That costs a few
 * milliseconds per event and buys the guarantee that if a turn produced a
 * number, the number is in the database — which is the only reason the metrics
 * in the README can be called measured.
 */
export class DbTracer implements Tracer {
  async startRun(info: {
    provider: string
    model: string
    channel: Channel
  }): Promise<TraceRunHandle> {
    const id = randomUUID()
    await getDb().insert(traceRuns).values({
      id,
      provider: info.provider,
      model: info.model,
      channel: info.channel,
    })

    let seq = 0
    return {
      id,
      event: async (input: TraceEventInput) => {
        await getDb()
          .insert(traceEvents)
          .values({
            runId: id,
            seq: seq++,
            type: input.type,
            payload: (input.payload ?? {}) as object,
            latencyMs: input.latencyMs ?? null,
            inputTokens: input.inputTokens ?? null,
            outputTokens: input.outputTokens ?? null,
            cachedTokens: input.cachedTokens ?? null,
            thoughtSummary: input.thoughtSummary ?? null,
          })
      },
      finish: async (result: RunFinish) => {
        await getDb()
          .update(traceRuns)
          .set({
            finishedAt: new Date(),
            status: result.status,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cachedTokens: result.usage.cachedTokens,
            costUsdEst: result.costUsdEst.toFixed(6),
            latencyMs: result.latencyMs,
          })
          .where(eq(traceRuns.id, id))
      },
    }
  }
}

export async function listRuns(limit = 50) {
  const rows = await getDb()
    .select()
    .from(traceRuns)
    .orderBy(desc(traceRuns.startedAt))
    .limit(limit)
  return rows.map((row) => ({
    ...row,
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    cachedTokens: Number(row.cachedTokens),
    costUsdEst: Number(row.costUsdEst),
    cachedPercent:
      Number(row.inputTokens) > 0
        ? Math.round((Number(row.cachedTokens) / Number(row.inputTokens)) * 1000) / 10
        : 0,
  }))
}

export async function getRun(id: string) {
  const [run] = await getDb().select().from(traceRuns).where(eq(traceRuns.id, id)).limit(1)
  if (!run) return undefined
  const events = await getDb()
    .select()
    .from(traceEvents)
    .where(eq(traceEvents.runId, id))
    .orderBy(traceEvents.seq)
  return {
    run: {
      ...run,
      inputTokens: Number(run.inputTokens),
      outputTokens: Number(run.outputTokens),
      cachedTokens: Number(run.cachedTokens),
      costUsdEst: Number(run.costUsdEst),
    },
    events: events.map((event) => ({
      ...event,
      inputTokens: event.inputTokens === null ? null : Number(event.inputTokens),
      outputTokens: event.outputTokens === null ? null : Number(event.outputTokens),
      cachedTokens: event.cachedTokens === null ? null : Number(event.cachedTokens),
    })),
  }
}

/**
 * Aggregate cache savings across runs — the headline metric (spec 18).
 * Restricted to model calls that actually had a prompt, so a run that errored
 * before its first call cannot dilute the percentage.
 */
export async function cacheStats(): Promise<{
  runs: number
  inputTokens: number
  cachedTokens: number
  savingsPercent: number
}> {
  const rows = await getDb().select().from(traceRuns)
  const withInput = rows.filter((r) => Number(r.inputTokens) > 0)
  const inputTokens = withInput.reduce((sum, r) => sum + Number(r.inputTokens), 0)
  const cachedTokens = withInput.reduce((sum, r) => sum + Number(r.cachedTokens), 0)
  return {
    runs: withInput.length,
    inputTokens,
    cachedTokens,
    savingsPercent: inputTokens > 0 ? Math.round((cachedTokens / inputTokens) * 1000) / 10 : 0,
  }
}
