import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatUsd } from '@kakeibo/core'
import type { EvalReport } from '@kakeibo/evals'
import { Badge, Card, EmptyState, Stat } from '@/components/ui'

/**
 * The evals page (spec 13): renders `evals/report/latest.json` if it exists.
 *
 * Reading the committed artefact rather than running anything is the point. An
 * eval run costs real money and takes minutes; the report is the deliverable and
 * it is in git, so this page is honest about being a view of the last run rather
 * than a live dashboard.
 */

export const dynamic = 'force-dynamic'

function loadReport(): EvalReport | null {
  try {
    const root = process.cwd().replace(/\/(packages|apps)\/[^/]+$/, '')
    return JSON.parse(readFileSync(join(root, 'evals', 'report', 'latest.json'), 'utf8'))
  } catch {
    return null
  }
}

export default function EvalsPage() {
  const report = loadReport()

  if (!report) {
    return (
      <div className="space-y-5">
        <h1 className="text-lg text-ink-100">Evals</h1>
        <EmptyState
          title="No eval report yet."
          hint="Run `pnpm eval` to generate evals/report/latest.json."
        />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg text-ink-100">Evals</h1>
        <p className="mt-1 text-xs text-ink-500">
          {report.taskCount} golden tasks · agent{' '}
          <code className="text-ink-300">{report.model}</code> · judge{' '}
          <code className="text-ink-300">{report.judgeModel}</code> ·{' '}
          {new Date(report.finishedAt).toLocaleString()}
        </p>
      </div>

      <Card className="grid grid-cols-2 divide-x divide-y divide-ink-800 sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6">
        <Stat
          label="pass rate"
          value={`${report.passed}/${report.taskCount}`}
          hint={`${report.passRate}%`}
        />
        <Stat
          label="median latency"
          value={`${(report.medianLatencyMs / 1000).toFixed(1)}s`}
          hint={`p95 ${(report.p95LatencyMs / 1000).toFixed(1)}s`}
        />
        <Stat label="median cost" value={formatUsd(report.medianCostUsd)} hint="per task" />
        <Stat label="median turns" value={report.medianTurns} />
        <Stat
          label="cache savings"
          value={`${report.cacheSavingsPercent}%`}
          hint="of prompt tokens"
        />
        <Stat
          label="injection block"
          value={report.injectionBlockRate === null ? '—' : `${report.injectionBlockRate}%`}
        />
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_2fr]">
        <Card className="p-4">
          <h2 className="mb-3 text-xs uppercase tracking-wide text-ink-500">By class</h2>
          <div className="space-y-2">
            {Object.entries(report.byClass)
              .sort()
              .map(([name, stats]) => (
                <div key={name} className="flex items-center gap-2">
                  <span className="w-32 shrink-0 truncate font-mono text-[11px] text-ink-300">
                    {name}
                  </span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-850">
                    <div
                      className={stats.passRate === 100 ? 'h-full bg-ok' : 'h-full bg-warn'}
                      style={{ width: `${stats.passRate}%` }}
                    />
                  </div>
                  <span className="num w-12 shrink-0 text-right text-[11px] text-ink-500">
                    {stats.passed}/{stats.total}
                  </span>
                </div>
              ))}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-ink-800 text-[11px] uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-normal">task</th>
                <th className="px-3 py-2.5 font-normal">class</th>
                <th className="px-3 py-2.5 font-normal">result</th>
                <th className="px-3 py-2.5 text-right font-normal">judge</th>
                <th className="px-3 py-2.5 text-right font-normal">latency</th>
                <th className="px-4 py-2.5 text-right font-normal">cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800/60">
              {report.results.map((result) => (
                <tr key={result.task.id} className="transition-colors hover:bg-ink-850/50">
                  <td className="px-4 py-2 font-mono text-ink-300">{result.task.id}</td>
                  <td className="px-3 py-2 font-mono text-ink-500">{result.task.class}</td>
                  <td className="px-3 py-2">
                    <Badge tone={result.passed ? 'ok' : 'danger'}>
                      {result.passed ? 'pass' : 'fail'}
                    </Badge>
                  </td>
                  <td className="num px-3 py-2 text-right text-ink-500">
                    {result.judgeScore === null ? '—' : `${result.judgeScore.toFixed(1)}/5`}
                  </td>
                  <td className="num px-3 py-2 text-right text-ink-500">
                    {(result.latencyMs / 1000).toFixed(1)}s
                  </td>
                  <td className="num px-4 py-2 text-right text-ink-500">
                    {formatUsd(result.costUsdEst)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      {report.results.some((r) => !r.passed) ? (
        <Card className="p-4">
          <h2 className="mb-3 text-xs uppercase tracking-wide text-ink-500">Failures</h2>
          <div className="space-y-4">
            {report.results
              .filter((r) => !r.passed)
              .map((result) => (
                <div key={result.task.id}>
                  <p className="font-mono text-xs text-ink-100">{result.task.id}</p>
                  <p className="mt-0.5 text-[11px] text-ink-500">{result.task.description}</p>
                  <ul className="mt-1.5 space-y-1">
                    {result.checks
                      .filter((c) => !c.passed)
                      .map((check, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: static list
                        <li key={i} className="font-mono text-[11px] text-danger">
                          {check.type}: {check.detail}
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
          </div>
        </Card>
      ) : null}

      <p className="text-[11px] text-ink-500">
        Costs are list-price estimates. Deterministic checks gate pass/fail; the judge only refines.
      </p>
    </div>
  )
}
