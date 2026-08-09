import { formatUsd } from '@kakeibo/core'
import { Margin, MarginHeading } from '@/components/exchange'
import { Empty, Figure, Mark, MetaLine, Section } from '@/components/ledger'
import { loadReport } from '@/lib/report'

/**
 * /evals — the last eval run, as a report in the book.
 *
 * Moved out of the terminal genre deliberately. A trace is a machine's own
 * record and belongs in the machine room; an eval report is a *finding*, written
 * for a person deciding whether to believe the thing — which makes it a product
 * surface, and the account book is where this product writes findings down.
 *
 * It renders `evals/report/latest.json` and runs nothing. An eval run costs real
 * money and takes minutes; the report is the deliverable and it is in git, so
 * this page is honest about being a view of the last run rather than a live
 * dashboard.
 *
 * There is no chart of the per-class pass rates, and that is a decision rather
 * than an omission: every class currently passes at 100%, and twelve bars all
 * drawn to full width is a picture of nothing that reads as a picture of
 * something. The figures are ruled instead, and a class that ever drops gets a
 * status word next to it that a full-width bar could never have given it.
 */

export const dynamic = 'force-dynamic'

export default function EvalsPage() {
  const report = loadReport()

  if (!report) {
    return (
      <div>
        <header className="border-b border-sumi-900 pb-6">
          <h1 className="font-serif text-[clamp(1.75rem,5vw,2.5rem)] leading-[1.1] tracking-[-0.025em]">
            Evals
          </h1>
        </header>
        <div className="mt-10">
          <Empty
            title="No eval report is committed yet."
            hint="Run pnpm eval to produce evals/report/latest.json."
          />
        </div>
      </div>
    )
  }

  const failures = report.results.filter((result) => !result.passed)
  const finished = new Date(report.finishedAt)

  return (
    <div>
      <header className="grid gap-x-10 gap-y-6 border-b border-sumi-900 pb-7 lg:grid-cols-[minmax(0,1fr)_13.5rem]">
        <div className="min-w-0">
          <h1 className="font-serif text-[clamp(1.75rem,5vw,2.5rem)] leading-[1.1] tracking-[-0.025em]">
            Evals
          </h1>
          <p className="mt-3 max-w-[64ch] text-[15px] leading-[1.6] text-sumi-600">
            {report.taskCount} golden tasks across {Object.keys(report.byClass).length} classes, run
            end to end against a freshly seeded ledger. Deterministic checks gate every verdict; the
            judge only refines a pass that already held.
          </p>
        </div>

        <Margin>
          <MarginHeading>This run</MarginHeading>
          <dl className="mt-2 border-t border-rule-strong">
            <MetaLine
              label="finished"
              value={finished.toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            />
            <MetaLine label="agent" value={report.model} />
            <MetaLine label="judge" value={report.judgeModel} />
            <MetaLine label="run cost" value={formatUsd(report.totalCostUsd)} />
          </dl>
        </Margin>
      </header>

      {/*
       * Nothing here is green when it is fine.
       *
       * The paper genre spends colour only where something needs attention, and
       * a wall of passes needs none — colouring them costs the page the one
       * thing that makes a failure leap off it. So a full pass rate is ink, and
       * only a shortfall takes a tone.
       */}
      <div className="mt-9 grid grid-cols-2 gap-x-8 gap-y-8 sm:grid-cols-3 lg:grid-cols-6">
        <Figure
          label="Passed"
          value={`${report.passed}/${report.taskCount}`}
          note={`${report.passRate}%`}
          tone={report.passRate === 100 ? 'ink' : 'danger'}
        />
        <Figure
          label="Median latency"
          value={`${(report.medianLatencyMs / 1000).toFixed(1)}s`}
          note={`p95 ${(report.p95LatencyMs / 1000).toFixed(1)}s`}
        />
        <Figure label="Median cost" value={formatUsd(report.medianCostUsd)} note="per task" />
        <Figure label="Median turns" value={String(report.medianTurns)} note="model calls" />
        <Figure
          label="Cache savings"
          value={`${report.cacheSavingsPercent}%`}
          note="of prompt tokens"
        />
        <Figure
          label="Injection blocked"
          value={report.injectionBlockRate === null ? '—' : `${report.injectionBlockRate}%`}
          tone={
            report.injectionBlockRate === null || report.injectionBlockRate === 100
              ? 'ink'
              : 'danger'
          }
          note={report.injectionBlockRate === null ? 'not measured' : 'of attempts'}
        />
      </div>

      <Section
        title="By class"
        note="What the suite covers, and where a regression would show up first."
      >
        <div className="border-t border-rule-strong">
          {Object.entries(report.byClass)
            .sort()
            .map(([name, stats]) => (
              <div
                key={name}
                className="grid grid-cols-[minmax(0,1fr)_auto_5rem] items-baseline gap-4 border-b border-rule py-2.5"
              >
                <div className="truncate text-[13px] text-sumi-900">{name.replace(/_/g, ' ')}</div>
                {/*
                 * Empty when the class is clean. Printing "all" on every row
                 * gave the column twelve identical words, which is noise a
                 * reader has to scan past to find the one row that differs —
                 * the exact job this column exists to make easy.
                 */}
                <div>
                  {stats.passRate === 100 ? null : (
                    <Mark tone="danger">{`${stats.total - stats.passed} failing`}</Mark>
                  )}
                </div>
                <div className="num text-right text-[13px] text-sumi-900">
                  {stats.passed}/{stats.total}
                </div>
              </div>
            ))}
        </div>
      </Section>

      <Section
        title="Every task"
        note="Latency is agent time only — each task truncates and re-imports 352 transactions first, and charging that setup to the agent would flatter it."
      >
        {/*
         * Below `sm` this is not a table.
         *
         * Six columns need 42rem; a 390px screen gets a scroller, and a
         * horizontal scroller inside a vertically-scrolling page is a control
         * most readers never discover — the first column simply appeared to end
         * mid-word at the screen edge with five columns unreachable behind it.
         * A phone gets the same rows as ruled entries instead, task and verdict
         * on the first line and the figures beneath, which is how a narrow
         * column of a ledger has always carried a wide row.
         */}
        <ul className="border-t border-rule-strong sm:hidden">
          {report.results.map((result) => (
            <li key={result.task.id} className="border-b border-rule py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <code className="min-w-0 break-all font-mono text-[12px] text-sumi-900">
                  {result.task.id}
                </code>
                {result.passed ? (
                  <span className="shrink-0 text-[12px] uppercase tracking-[0.08em] text-sumi-500">
                    pass
                  </span>
                ) : (
                  <Mark tone="danger">fail</Mark>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12px] text-sumi-600">
                <span>{result.task.class.replace(/_/g, ' ')}</span>
                <span className="num">{(result.latencyMs / 1000).toFixed(1)}s</span>
                <span className="num">{formatUsd(result.costUsdEst)}</span>
                <span className="num">
                  {result.judgeScore === null
                    ? 'no judge'
                    : `judge ${result.judgeScore.toFixed(1)}/5`}
                </span>
              </div>
            </li>
          ))}
        </ul>

        <div className="-mx-6 hidden overflow-x-auto px-6 sm:block">
          <table className="w-full min-w-[42rem] border-collapse text-left">
            <thead>
              <tr className="border-y border-rule-strong text-[11px] uppercase tracking-[0.09em] text-sumi-500">
                <th className="py-2 pr-4 font-normal">Task</th>
                <th className="py-2 pr-4 font-normal">Class</th>
                <th className="py-2 pr-4 font-normal">Result</th>
                <th className="py-2 pr-4 text-right font-normal">Judge</th>
                <th className="py-2 pr-4 text-right font-normal">Latency</th>
                <th className="py-2 text-right font-normal">Cost</th>
              </tr>
            </thead>
            <tbody>
              {report.results.map((result) => (
                <tr key={result.task.id} className="border-b border-rule">
                  <td className="py-2 pr-4 text-[13px] text-sumi-900">
                    <code className="font-mono text-[12px]">{result.task.id}</code>
                  </td>
                  <td className="py-2 pr-4 text-[12px] text-sumi-600">
                    {result.task.class.replace(/_/g, ' ')}
                  </td>
                  <td className="py-2 pr-4">
                    {result.passed ? (
                      <span className="text-[12px] uppercase tracking-[0.08em] text-sumi-500">
                        pass
                      </span>
                    ) : (
                      <Mark tone="danger">fail</Mark>
                    )}
                  </td>
                  <td className="num py-2 pr-4 text-right text-[12px] text-sumi-600">
                    {result.judgeScore === null ? '—' : `${result.judgeScore.toFixed(1)}/5`}
                  </td>
                  <td className="num py-2 pr-4 text-right text-[12px] text-sumi-600">
                    {(result.latencyMs / 1000).toFixed(1)}s
                  </td>
                  <td className="num py-2 text-right text-[12px] text-sumi-900">
                    {formatUsd(result.costUsdEst)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {failures.length > 0 ? (
        <Section title="What failed" note="The checks that did not hold, verbatim.">
          <div className="border-t border-rule-strong">
            {failures.map((result) => (
              <div key={result.task.id} className="border-b border-rule py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <code className="font-mono text-[12px] text-sumi-900">{result.task.id}</code>
                  <span className="text-[12px] text-sumi-600">{result.task.description}</span>
                </div>
                <ul className="mt-1.5 space-y-1">
                  {result.checks
                    .filter((check) => !check.passed)
                    .map((check, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: static list
                      <li key={index} className="text-[12px] leading-relaxed text-danger-ink">
                        {check.type}: {check.detail}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <footer className="mt-16 border-t border-rule pt-4 text-[12px] leading-relaxed text-sumi-500">
        Costs are list-price estimates computed from the tokens each run actually reported.
        Reproduce this whole page with <code className="font-mono text-[11px]">pnpm eval</code>.
      </footer>
    </div>
  )
}
