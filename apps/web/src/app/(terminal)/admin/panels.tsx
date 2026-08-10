import { formatUsd } from '@kakeibo/core'
import type {
  AdminRun,
  AdminUser,
  BudgetPanel,
  HealthPanel,
  SafetyPanel,
  ToolStat,
  TrafficPanel,
} from '@kakeibo/ledger'
import Link from 'next/link'
import { Badge, Card, EmptyState, Stat, statusTone } from '@/components/ui'
import { BlockButton } from './actions'

/**
 * The eight admin panels (spec §9.3), presentational and server-rendered.
 *
 * Same primitives and table markup as `/runs`: `Card`, `Badge`, `Stat`,
 * `EmptyState`, the `num` class on numeric cells, `formatUsd` for money. This
 * page is the trace viewer's genre, not the warm editorial one.
 */

function Sparkline({ points, capUsd }: { points: { day: string; usd: number }[]; capUsd: number }) {
  const max = Math.max(capUsd, ...points.map((point) => point.usd))
  const width = 320
  const height = 40
  const step = width / Math.max(1, points.length - 1)
  const path = points
    .map((point, i) => `${i === 0 ? 'M' : 'L'} ${i * step} ${height - (point.usd / max) * height}`)
    .join(' ')
  // The cap drawn as a rule, not just implied by the shape: the question this
  // chart answers is "are we near the ceiling", not "what is the trend".
  const capY = height - (capUsd / max) * height

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-10 w-full"
      role="img"
      aria-label="30-day spend"
    >
      <line
        x1="0"
        y1={capY}
        x2={width}
        y2={capY}
        className="stroke-warn/40"
        strokeDasharray="2 3"
      />
      <path d={path} className="stroke-accent" fill="none" strokeWidth="1.5" />
    </svg>
  )
}

/** Budget (spec §9.3, item 1) — first and largest, because it is the number that can hurt. */
export function Budget({ panel }: { panel: BudgetPanel }) {
  const tone = panel.state === 'ok' ? 'ok' : panel.state === 'tripped' ? 'danger' : 'warn'
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-wide text-ink-500">Budget</h2>
        <Badge tone={tone}>{panel.state}</Badge>
      </div>
      <div className="mt-2 grid grid-cols-1 divide-y divide-ink-800 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Stat
          label="today"
          value={formatUsd(panel.todayUsd)}
          hint={`cap ${formatUsd(panel.dailyCapUsd)}`}
        />
        <Stat label="month to date" value={formatUsd(panel.monthToDateUsd)} />
        <Stat
          label="projected month"
          value={formatUsd(panel.projectedMonthUsd)}
          hint={`ceiling ${formatUsd(panel.monthlyCeilingUsd)}`}
        />
      </div>
      <div className="mt-3 px-4">
        <Sparkline points={panel.sparkline} capUsd={panel.dailyCapUsd} />
      </div>
    </Card>
  )
}

/** Traffic (spec §9.3, item 2). */
export function Traffic({ panel }: { panel: TrafficPanel }) {
  return (
    <Card className="p-4">
      <h2 className="text-xs uppercase tracking-wide text-ink-500">Traffic</h2>
      <div className="mt-2 grid grid-cols-3 divide-x divide-ink-800">
        <Stat label="today" value={panel.visitors.today} />
        <Stat label="7d" value={panel.visitors.d7} />
        <Stat label="30d" value={panel.visitors.d30} />
      </div>
      <div className="mt-2 grid grid-cols-3 divide-x divide-ink-800">
        <Stat label="anonymous" value={panel.anonymous} />
        <Stat
          label="signed in"
          value={panel.signedIn}
          hint={`${panel.conversionPercent}% conversion`}
        />
        <Stat label="returning" value={panel.returning} />
      </div>
    </Card>
  )
}

/** Health (spec §9.3, item 3) — is the site working, and how long does it take. */
export function Health({ panel }: { panel: HealthPanel }) {
  return (
    <Card className="p-4">
      <h2 className="text-xs uppercase tracking-wide text-ink-500">Health</h2>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge tone="ok">ok {panel.byStatus.ok}</Badge>
        <Badge tone="danger">error {panel.byStatus.error}</Badge>
        <Badge tone="warn">blocked {panel.byStatus.blocked}</Badge>
        <Badge tone="neutral">aborted {panel.byStatus.aborted}</Badge>
      </div>
      <div className="mt-2 grid grid-cols-2 divide-x divide-ink-800">
        <Stat label="p50 latency" value={`${(panel.p50LatencyMs / 1000).toFixed(1)}s`} />
        <Stat label="p95 latency" value={`${(panel.p95LatencyMs / 1000).toFixed(1)}s`} />
      </div>
      <div className="mt-2 grid grid-cols-2 divide-x divide-ink-800">
        <Stat label="tool errors" value={`${panel.toolErrorPercent}%`} />
        <Stat label="iteration limit hits" value={panel.iterationLimitHits} />
      </div>
    </Card>
  )
}

/** Safety (spec §9.3, item 4) — is the write-confirmation guardrail doing its job. */
export function Safety({ panel }: { panel: SafetyPanel }) {
  return (
    <Card className="p-4">
      <h2 className="text-xs uppercase tracking-wide text-ink-500">Safety</h2>
      <div className="mt-2 grid grid-cols-3 divide-x divide-y divide-ink-800">
        <Stat label="proposed" value={panel.proposed} />
        <Stat label="allowed" value={panel.allowed} />
        <Stat label="declined" value={panel.declined} />
        <Stat label="awaiting" value={panel.awaiting} />
        <Stat label="imports" value={panel.imports} />
      </div>
      <div className="mt-3">
        {panel.blockedRuns.length === 0 ? (
          <p className="text-[11px] text-ink-500">No blocked runs in the last 30 days.</p>
        ) : (
          <ul className="space-y-1">
            {panel.blockedRuns.map((run) => (
              <li key={run.runId} className="flex items-center gap-2 font-mono text-[11px]">
                <Link href={`/runs/${run.runId}`} className="text-accent-dim hover:text-accent">
                  {run.runId.slice(0, 8)}
                </Link>
                <span className="truncate text-ink-500">{run.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

/** Tools (spec §9.3, item 5) — which tools are actually earning selection. */
export function Tools({ stats }: { stats: ToolStat[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-ink-800 px-4 py-2.5">
        <h2 className="text-xs uppercase tracking-wide text-ink-500">Tools</h2>
      </div>
      {stats.length === 0 ? (
        <div className="p-4">
          <EmptyState
            title="No tool calls yet."
            hint="Ask the agent something that needs a lookup."
          />
        </div>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="border-b border-ink-800 text-[11px] uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2 font-normal">tool</th>
              <th className="px-3 py-2 text-right font-normal">calls</th>
              <th className="px-3 py-2 text-right font-normal">errors</th>
              <th className="px-4 py-2 text-right font-normal">median</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800/60">
            {stats.map((tool) => (
              <tr key={tool.name}>
                <td className="px-4 py-1.5 font-mono text-ink-300">{tool.name}</td>
                <td className="num px-3 py-1.5 text-right text-ink-300">
                  {tool.calls.toLocaleString()}
                </td>
                <td className="num px-3 py-1.5 text-right text-ink-300">
                  {tool.errorPercent > 0 ? (
                    <span className="text-danger">{tool.errorPercent}%</span>
                  ) : (
                    <span className="text-ink-700">0%</span>
                  )}
                </td>
                <td className="num px-4 py-1.5 text-right text-ink-300">
                  {tool.medianLatencyMs}ms
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

/**
 * Recent runs (spec §9.3, item 6) — the `/runs` table, unscoped and widened
 * with an owner column, which is the entire difference between a visitor's
 * own view and the operator's.
 */
export function RecentRuns({ runs }: { runs: AdminRun[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-ink-800 px-4 py-2.5">
        <h2 className="text-xs uppercase tracking-wide text-ink-500">Recent runs</h2>
      </div>
      {runs.length === 0 ? (
        <div className="p-4">
          <EmptyState title="No runs yet." hint="Nobody has talked to the agent yet." />
        </div>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="border-b border-ink-800 text-[11px] uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2.5 font-normal">time</th>
              <th className="px-3 py-2.5 font-normal">owner</th>
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
                    {run.startedAt.toLocaleString()}
                  </Link>
                </td>
                <td className="px-3 py-2 font-mono text-ink-500">
                  {run.ownerEmail ?? '(reaped)'}
                  {run.ownerIsAnonymous ? <span className="ml-1 text-ink-700">anon</span> : null}
                </td>
                <td className="px-3 py-2 font-mono text-ink-500">{run.channel}</td>
                <td className="px-3 py-2 font-mono text-ink-500">{run.model}</td>
                <td className="num px-3 py-2 text-right text-ink-300">
                  {run.inputTokens.toLocaleString()}
                </td>
                <td className="num px-3 py-2 text-right text-ink-300">
                  {run.cachedTokens.toLocaleString()}
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
      )}
    </Card>
  )
}

/** Users (spec §9.3, item 7) — who is using the site and what they are costing. */
export function Users({ users }: { users: AdminUser[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-ink-800 px-4 py-2.5">
        <h2 className="text-xs uppercase tracking-wide text-ink-500">Users</h2>
      </div>
      {users.length === 0 ? (
        <div className="p-4">
          <EmptyState title="No users yet." hint="Nobody has signed in." />
        </div>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="border-b border-ink-800 text-[11px] uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2.5 font-normal">email</th>
              <th className="px-3 py-2.5 font-normal">joined</th>
              <th className="px-3 py-2.5 font-normal">last seen</th>
              <th className="px-3 py-2.5 text-right font-normal">today</th>
              <th className="px-3 py-2.5 text-right font-normal">cost to date</th>
              <th className="px-3 py-2.5 font-normal">status</th>
              <th className="px-4 py-2.5 font-normal" aria-label="action" />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800/60">
            {users.map((row) => (
              <tr key={row.id} className="transition-colors hover:bg-ink-850/50">
                <td className="px-4 py-2 font-mono text-ink-300">
                  {row.email}
                  {row.isAnonymous ? <span className="ml-1.5 text-ink-700">anon</span> : null}
                </td>
                <td className="px-3 py-2 font-mono text-ink-500">
                  {row.createdAt.toLocaleDateString()}
                </td>
                <td className="px-3 py-2 font-mono text-ink-500">
                  {row.lastSeenAt ? row.lastSeenAt.toLocaleString() : 'never'}
                </td>
                <td className="num px-3 py-2 text-right text-ink-300">{row.messagesToday}</td>
                <td className="num px-3 py-2 text-right text-ink-300">
                  {formatUsd(row.costUsdToDate)}
                </td>
                <td className="px-3 py-2">
                  {row.blockedAt ? (
                    <Badge tone="danger">blocked</Badge>
                  ) : (
                    <Badge tone="ok">active</Badge>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <BlockButton ownerId={row.id} blocked={row.blockedAt !== null} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
