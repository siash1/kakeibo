import { formatUsd } from '@kakeibo/core'
import { cacheStats, listRuns } from '@kakeibo/ledger'
import Link from 'next/link'
import { Badge, Card, EmptyState, Stat, statusTone } from '@/components/ui'
import { viewerOwner } from '@/lib/owner'

/**
 * The trace list (spec 13). Every turn, every channel, with the numbers that
 * matter for cost and caching in the same table — this is the observability
 * deliverable, not a debug page.
 */

export const dynamic = 'force-dynamic'

export default async function RunsPage() {
  // Scoped to whoever is looking. A visitor sees their own turns and nobody
  // else's; the operator's view across every owner is the admin dashboard in
  // Plan C, which is the only place allowed to read unscoped.
  const viewer = await viewerOwner()
  const [runs, cache] = viewer
    ? await Promise.all([listRuns(viewer.owner, 100), cacheStats(viewer.owner)])
    : [[], { runs: 0, inputTokens: 0, cachedTokens: 0, savingsPercent: 0 }]

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg text-ink-100">Traces</h1>
        <p className="mt-1 text-xs text-ink-500">
          One row per turn. Every model call and tool call is recorded synchronously; nothing here
          is sampled or estimated.
        </p>
      </div>

      <Card className="grid grid-cols-2 divide-x divide-ink-800 sm:grid-cols-4">
        <Stat label="runs" value={runs.length} />
        <Stat
          label="cache savings"
          value={`${cache.savingsPercent}%`}
          hint={`${cache.cachedTokens.toLocaleString()} / ${cache.inputTokens.toLocaleString()} tokens`}
        />
        <Stat
          label="total cost"
          value={formatUsd(runs.reduce((sum, run) => sum + run.costUsdEst, 0))}
          hint="list-price estimate"
        />
        <Stat
          label="median latency"
          value={`${(median(runs.map((r) => r.latencyMs)) / 1000).toFixed(1)}s`}
        />
      </Card>

      {runs.length === 0 ? (
        <EmptyState title="No runs yet." hint="Ask something on the chat page." />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-ink-800 text-[11px] uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-normal">time</th>
                <th className="px-3 py-2.5 font-normal">channel</th>
                <th className="px-3 py-2.5 font-normal">model</th>
                <th className="px-3 py-2.5 text-right font-normal">in</th>
                <th className="px-3 py-2.5 text-right font-normal">cached</th>
                <th className="px-3 py-2.5 text-right font-normal">out</th>
                <th className="px-3 py-2.5 text-right font-normal">cost</th>
                <th className="px-3 py-2.5 text-right font-normal">latency</th>
                <th className="px-4 py-2.5 font-normal">status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800/60">
              {runs.map((run) => (
                <tr key={run.id} className="transition-colors hover:bg-ink-850/50">
                  <td className="px-4 py-2">
                    <Link
                      href={`/runs/${run.id}`}
                      className="font-mono text-accent-dim hover:text-accent"
                    >
                      {new Date(run.startedAt).toLocaleTimeString()}
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-mono text-ink-500">{run.channel}</td>
                  <td className="px-3 py-2 font-mono text-ink-500">{run.model}</td>
                  <td className="num px-3 py-2 text-right text-ink-300">
                    {run.inputTokens.toLocaleString()}
                  </td>
                  <td className="num px-3 py-2 text-right text-ink-300">
                    {run.cachedPercent > 0 ? (
                      <span className="text-accent">{run.cachedPercent}%</span>
                    ) : (
                      <span className="text-ink-700">0%</span>
                    )}
                  </td>
                  <td className="num px-3 py-2 text-right text-ink-300">
                    {run.outputTokens.toLocaleString()}
                  </td>
                  <td className="num px-3 py-2 text-right text-ink-300">
                    {formatUsd(run.costUsdEst)}
                  </td>
                  <td className="num px-3 py-2 text-right text-ink-300">
                    {(run.latencyMs / 1000).toFixed(1)}s
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
