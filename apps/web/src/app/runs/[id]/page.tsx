import { formatUsd } from '@kakeibo/core'
import { DEV_OWNER_ID, getRun } from '@kakeibo/ledger'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Badge, Card, Stat, statusTone } from '@/components/ui'

/**
 * The per-run timeline (spec 13).
 *
 * Every model call shows tokens in/out, how many were cached, latency, and the
 * thought summary when one was recorded. Every tool call shows its arguments and
 * its result. The collapsible JSON is deliberate — the summary line is what you
 * read, the payload is what you open when the summary surprises you.
 */

export const dynamic = 'force-dynamic'

interface EventRow {
  id: string
  seq: number
  type: string
  payload: unknown
  latencyMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  thoughtSummary: string | null
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const data = await getRun(DEV_OWNER_ID, id)
  if (!data) notFound()

  const { run, events } = data
  const cachedPercent =
    run.inputTokens > 0 ? Math.round((run.cachedTokens / run.inputTokens) * 1000) / 10 : 0

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/runs" className="font-mono text-xs text-accent-dim hover:text-accent">
          ← traces
        </Link>
        <span className="font-mono text-xs text-ink-500">{run.id}</span>
        <Badge tone={statusTone(run.status)}>{run.status}</Badge>
      </div>

      <Card className="grid grid-cols-2 divide-x divide-y divide-ink-800 sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6">
        <Stat label="channel" value={run.channel} />
        <Stat label="model" value={<span className="text-sm">{run.model}</span>} />
        <Stat
          label="input"
          value={run.inputTokens.toLocaleString()}
          hint={`${cachedPercent}% cached`}
        />
        <Stat label="output" value={run.outputTokens.toLocaleString()} />
        <Stat label="cost" value={formatUsd(run.costUsdEst)} hint="list-price estimate" />
        <Stat label="latency" value={`${(run.latencyMs / 1000).toFixed(1)}s`} />
      </Card>

      <div className="space-y-2">
        {events.map((event) => (
          <EventCard key={event.id} event={event as EventRow} />
        ))}
      </div>
    </div>
  )
}

function EventCard({ event }: { event: EventRow }) {
  const payload = event.payload as Record<string, unknown>

  if (event.type === 'model_call') {
    return (
      <Card className="px-4 py-3">
        <Header seq={event.seq} type="model call" tone="accent" latencyMs={event.latencyMs}>
          <span className="font-mono text-[11px] text-ink-500">
            {event.inputTokens?.toLocaleString()} in · {event.cachedTokens?.toLocaleString()} cached
            · {event.outputTokens?.toLocaleString()} out
          </span>
          <Badge>{String(payload.stopReason ?? '')}</Badge>
          {payload.replayed ? <Badge tone="warn">replayed</Badge> : null}
          {payload.cacheRef ? <Badge tone="accent">explicit cache</Badge> : null}
        </Header>
        {event.thoughtSummary ? (
          <details className="mt-2">
            <summary className="cursor-pointer font-mono text-[11px] text-ink-500 hover:text-ink-300">
              thought summary
            </summary>
            <pre className="mt-2 whitespace-pre-wrap rounded bg-ink-950 p-3 text-[11px] leading-relaxed text-ink-300">
              {event.thoughtSummary}
            </pre>
          </details>
        ) : null}
        <Json label="content" value={payload.content} />
      </Card>
    )
  }

  if (event.type === 'tool_call') {
    const isError = Boolean(payload.error)
    return (
      <Card className={isError ? 'border-danger/40 px-4 py-3' : 'px-4 py-3'}>
        <Header
          seq={event.seq}
          type={`tool · ${String(payload.name ?? '')}`}
          tone={isError ? 'danger' : payload.tier === 'write' ? 'warn' : 'neutral'}
          latencyMs={event.latencyMs}
        >
          {payload.confirmed !== undefined ? (
            <Badge tone={payload.confirmed ? 'ok' : 'neutral'}>
              {payload.confirmed ? 'confirmed' : 'declined'}
            </Badge>
          ) : null}
          {isError ? <Badge tone="danger">error</Badge> : null}
        </Header>
        {isError ? (
          <p className="mt-1.5 font-mono text-[11px] text-danger">{String(payload.error)}</p>
        ) : null}
        <Json label="args" value={payload.args} />
        <Json label="result" value={payload.result} />
      </Card>
    )
  }

  if (event.type === 'confirm') {
    return (
      <Card className="border-warn/40 bg-warn/5 px-4 py-3">
        <Header seq={event.seq} type="confirmation" tone="warn" latencyMs={event.latencyMs}>
          <Badge tone={payload.allowed ? 'ok' : 'neutral'}>
            {payload.allowed ? 'allowed' : 'declined'}
          </Badge>
        </Header>
        <p className="mt-1.5 text-sm text-ink-100">{String(payload.summary ?? '')}</p>
        <Json label="args" value={payload.args} />
      </Card>
    )
  }

  if (event.type === 'summary_eviction') {
    return (
      <Card className="border-accent-dim/40 px-4 py-3">
        <Header seq={event.seq} type="context eviction" tone="accent" latencyMs={event.latencyMs}>
          <span className="font-mono text-[11px] text-ink-500">
            {String(payload.tokensBefore)} → {String(payload.tokensAfter)} tokens ·{' '}
            {String(payload.evictedTurns)} turns summarised
          </span>
        </Header>
        <pre className="mt-2 whitespace-pre-wrap rounded bg-ink-950 p-3 text-[11px] leading-relaxed text-ink-300">
          {String(payload.summary ?? '')}
        </pre>
      </Card>
    )
  }

  return (
    <Card className="border-danger/40 px-4 py-3">
      <Header seq={event.seq} type={event.type} tone="danger" latencyMs={event.latencyMs} />
      <Json label="payload" value={payload} open />
    </Card>
  )
}

function Header({
  seq,
  type,
  tone,
  latencyMs,
  children,
}: {
  seq: number
  type: string
  tone: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'
  latencyMs: number | null
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="num text-[11px] text-ink-700">{String(seq).padStart(2, '0')}</span>
      <Badge tone={tone}>{type}</Badge>
      {children}
      {latencyMs !== null ? (
        <span className="num ml-auto text-[11px] text-ink-500">{latencyMs}ms</span>
      ) : null}
    </div>
  )
}

function Json({ label, value, open }: { label: string; value: unknown; open?: boolean }) {
  if (value === undefined || value === null) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <details className="mt-2" open={open}>
      <summary className="cursor-pointer font-mono text-[11px] text-ink-500 hover:text-ink-300">
        {label}
      </summary>
      <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-ink-950 p-3 text-[11px] leading-relaxed text-ink-300">
        {text}
      </pre>
    </details>
  )
}
