import { randomUUID } from 'node:crypto'
import type { Channel } from '@kakeibo/core/registry'
import type { RunFinish, TraceEventInput, TraceRunHandle, Tracer } from '@kakeibo/core/trace'
import { and, desc, eq, sql } from 'drizzle-orm'
import { withOwner } from '../db'
import type { OwnerId } from '../owner'
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
  // Owner is a constructor dependency, not a method parameter: Tracer is a
  // core interface and core must not learn about tenancy.
  constructor(private readonly owner: OwnerId) {}

  async startRun(info: {
    provider: string
    model: string
    channel: Channel
  }): Promise<TraceRunHandle> {
    const id = randomUUID()
    const owner = this.owner
    await withOwner(owner, (tx) =>
      tx.insert(traceRuns).values({
        id,
        ownerId: owner,
        provider: info.provider,
        model: info.model,
        channel: info.channel,
      }),
    )
    return this.handle(id, 0)
  }

  /**
   * Reopens an existing run so a suspended turn continues one trace.
   *
   * The sequence continues from what is already stored rather than restarting
   * at zero: two events sharing seq 0 sort ambiguously, and the timeline sorts
   * on exactly that column.
   */
  async resumeRun(runId: string): Promise<TraceRunHandle> {
    const owner = this.owner
    const rows = await withOwner(owner, (tx) =>
      tx
        .select({ maxSeq: sql<number>`coalesce(max(${traceEvents.seq}), -1)::int` })
        .from(traceEvents)
        .where(and(eq(traceEvents.ownerId, owner), eq(traceEvents.runId, runId))),
    )
    return this.handle(runId, Number(rows[0]?.maxSeq ?? -1) + 1)
  }

  /** The event and finish logic, shared so start and resume cannot drift. */
  private handle(id: string, startSeq: number): TraceRunHandle {
    const owner = this.owner
    let seq = startSeq
    return {
      id,
      event: async (input: TraceEventInput) => {
        await withOwner(owner, (tx) =>
          tx.insert(traceEvents).values({
            ownerId: owner,
            runId: id,
            seq: seq++,
            type: input.type,
            payload: (input.payload ?? {}) as object,
            latencyMs: input.latencyMs ?? null,
            inputTokens: input.inputTokens ?? null,
            outputTokens: input.outputTokens ?? null,
            cachedTokens: input.cachedTokens ?? null,
            thoughtSummary: input.thoughtSummary ?? null,
          }),
        )
      },
      finish: async (result: RunFinish) => {
        await withOwner(owner, (tx) =>
          tx
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
            .where(and(eq(traceRuns.ownerId, owner), eq(traceRuns.id, id))),
        )
      },
    }
  }
}

export async function listRuns(owner: OwnerId, limit = 50) {
  const rows = await withOwner(owner, (tx) =>
    tx
      .select()
      .from(traceRuns)
      .where(eq(traceRuns.ownerId, owner))
      .orderBy(desc(traceRuns.startedAt))
      .limit(limit),
  )
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

export async function getRun(owner: OwnerId, id: string) {
  // Returning undefined for another owner's run id is what lets the trace
  // viewer 404 rather than leak that the run exists at all.
  const [run] = await withOwner(owner, (tx) =>
    tx
      .select()
      .from(traceRuns)
      .where(and(eq(traceRuns.ownerId, owner), eq(traceRuns.id, id)))
      .limit(1),
  )
  if (!run) return undefined
  const events = await withOwner(owner, (tx) =>
    tx
      .select()
      .from(traceEvents)
      .where(and(eq(traceEvents.ownerId, owner), eq(traceEvents.runId, id)))
      .orderBy(traceEvents.seq),
  )
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
export async function cacheStats(owner: OwnerId): Promise<{
  runs: number
  inputTokens: number
  cachedTokens: number
  savingsPercent: number
}> {
  const rows = await withOwner(owner, (tx) =>
    tx.select().from(traceRuns).where(eq(traceRuns.ownerId, owner)),
  )
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
