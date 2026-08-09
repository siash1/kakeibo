import { randomUUID } from 'node:crypto'
import type { Channel } from './registry'
import type { Usage } from './types'

/**
 * Tracing is synchronous and always on (spec 8.7). It is not a debug flag: the
 * trace tables *are* the observability deliverable, and every number in the
 * README is read back out of them rather than estimated.
 *
 * The interface lives in core and the Postgres implementation lives in ledger,
 * which keeps the dependency direction clean (ledger -> core) and lets tests
 * run the whole loop against an in-memory tracer with no database.
 */

export type TraceEventType = 'model_call' | 'tool_call' | 'confirm' | 'summary_eviction' | 'error'
export type RunStatus = 'ok' | 'error' | 'blocked' | 'aborted'

export interface TraceEventInput {
  type: TraceEventType
  payload: unknown
  latencyMs?: number
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  thoughtSummary?: string
}

export interface TraceEventRecord extends TraceEventInput {
  id: string
  runId: string
  seq: number
}

export interface RunFinish {
  status: RunStatus
  usage: Usage
  costUsdEst: number
  latencyMs: number
}

export interface TraceRunHandle {
  readonly id: string
  event(input: TraceEventInput): Promise<void>
  finish(result: RunFinish): Promise<void>
}

/**
 * A coarse, city-level location for one turn.
 *
 * Provider-neutral by design: core must not learn what Vercel is. Every field
 * is optional because the edge resolves some addresses only partially, and all
 * of them are absent in local development.
 */
export interface RunGeo {
  country?: string
  region?: string
  city?: string
  lat?: number
  lon?: number
}

export interface Tracer {
  startRun(info: {
    provider: string
    model: string
    channel: Channel
    geo?: RunGeo
  }): Promise<TraceRunHandle>
  /**
   * Reopens an existing run so a suspended turn continues one trace.
   *
   * Without it a turn that paused for a confirmation produces two runs: the
   * viewer shows half a conversation twice, and the per-owner quota counts one
   * turn as two.
   */
  resumeRun(runId: string): Promise<TraceRunHandle>
}

/** Keeps runs in memory. Used by unit tests and by the MCP server, which has no run of its own. */
export class InMemoryTracer implements Tracer {
  readonly runs: {
    id: string
    provider: string
    model: string
    channel: Channel
    startedAt: number
    events: TraceEventRecord[]
    finish?: RunFinish
  }[] = []

  async startRun(info: {
    provider: string
    model: string
    channel: Channel
    geo?: RunGeo
  }): Promise<TraceRunHandle> {
    const id = randomUUID()
    const run = { id, ...info, startedAt: Date.now(), events: [] as TraceEventRecord[] }
    this.runs.push(run)
    let seq = 0
    return {
      id,
      event: async (input) => {
        run.events.push({ id: randomUUID(), runId: id, seq: seq++, ...input })
      },
      finish: async (result) => {
        Object.assign(run, { finish: result })
      },
    }
  }

  async resumeRun(runId: string): Promise<TraceRunHandle> {
    const run = this.runs.find((r) => r.id === runId)
    if (!run) throw new Error(`No run ${runId} to resume`)
    // Continue the sequence rather than restarting it; the timeline sorts on it.
    let seq = run.events.length
    return {
      id: runId,
      event: async (input) => {
        run.events.push({ id: randomUUID(), runId, seq: seq++, ...input })
      },
      finish: async (result) => {
        Object.assign(run, { finish: result })
      },
    }
  }

  eventsOfType(type: TraceEventType): TraceEventRecord[] {
    return this.runs.flatMap((r) => r.events).filter((e) => e.type === type)
  }

  lastRun() {
    return this.runs[this.runs.length - 1]
  }
}

/** Discards everything. Only for benchmarks where tracing itself is the thing being measured. */
export class NoopTracer implements Tracer {
  async startRun(): Promise<TraceRunHandle> {
    return this.handle(randomUUID())
  }

  async resumeRun(runId: string): Promise<TraceRunHandle> {
    return this.handle(runId)
  }

  private handle(id: string): TraceRunHandle {
    return { id, event: async () => {}, finish: async () => {} }
  }
}

/** Trace payloads are stored verbatim; long tool results get clipped first. */
export function clipForTrace(value: unknown, maxChars = 4000): unknown {
  if (typeof value === 'string') {
    return value.length <= maxChars
      ? value
      : `${value.slice(0, maxChars)}… [${value.length} chars total]`
  }
  if (value === null || value === undefined) return value
  const json = JSON.stringify(value)
  if (json !== undefined && json.length <= maxChars) return value
  return `${json?.slice(0, maxChars)}… [${json?.length ?? 0} chars total]`
}
