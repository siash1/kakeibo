import { formatUsd } from '@kakeibo/core'
import type { EvalReport } from './types'

/** Renders `evals/report/latest.md` (spec 11). */
export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = []

  lines.push('# kakeibo eval report')
  lines.push('')
  lines.push(`Run ${report.startedAt} → ${report.finishedAt}`)
  lines.push('')
  lines.push('| metric | value |')
  lines.push('| --- | --- |')
  lines.push(`| pass rate | **${report.passed} / ${report.taskCount}** (${report.passRate}%) |`)
  lines.push(`| agent model | \`${report.model}\` |`)
  lines.push(`| judge model | \`${report.judgeModel}\` |`)
  lines.push(`| median latency | ${(report.medianLatencyMs / 1000).toFixed(1)} s |`)
  lines.push(`| p95 latency | ${(report.p95LatencyMs / 1000).toFixed(1)} s |`)
  lines.push(`| median cost / task | ${formatUsd(report.medianCostUsd)} |`)
  lines.push(`| total cost | ${formatUsd(report.totalCostUsd)} |`)
  lines.push(`| median turns | ${report.medianTurns} |`)
  lines.push(`| context-cache savings | ${report.cacheSavingsPercent}% of prompt tokens |`)
  if (report.injectionBlockRate !== null) {
    lines.push(`| injection block rate | ${report.injectionBlockRate}% |`)
  }
  lines.push('')
  lines.push('All costs are list-price estimates (see `packages/core/src/pricing.ts`).')
  lines.push('')

  lines.push('## By class')
  lines.push('')
  lines.push('| class | passed | total | rate |')
  lines.push('| --- | --- | --- | --- |')
  for (const [name, stats] of Object.entries(report.byClass).sort()) {
    lines.push(`| ${name} | ${stats.passed} | ${stats.total} | ${stats.passRate}% |`)
  }
  lines.push('')

  lines.push('## Tasks')
  lines.push('')
  lines.push('| task | class | result | judge | latency | cost | tools |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const result of report.results) {
    lines.push(
      `| \`${result.task.id}\` | ${result.task.class} | ${result.passed ? 'pass' : '**FAIL**'} |` +
        ` ${result.judgeScore === null ? '—' : `${result.judgeScore.toFixed(1)}/5`} |` +
        ` ${(result.latencyMs / 1000).toFixed(1)}s | ${formatUsd(result.costUsdEst)} | ${result.toolCallCount} |`,
    )
  }
  lines.push('')

  const failures = report.results.filter((r) => !r.passed)
  if (failures.length > 0) {
    lines.push('## Failures')
    lines.push('')
    for (const failure of failures) {
      lines.push(`### \`${failure.task.id}\` — ${failure.task.description}`)
      lines.push('')
      if (failure.error) lines.push(`Turn error: \`${failure.error}\``)
      for (const check of failure.checks.filter((c) => !c.passed)) {
        lines.push(`- **${check.type}**: ${check.detail}`)
      }
      lines.push('')
      lines.push('<details><summary>answer</summary>')
      lines.push('')
      lines.push('```')
      lines.push(failure.answers.join('\n---\n').slice(0, 2000))
      lines.push('```')
      lines.push('')
      lines.push('</details>')
      lines.push('')
    }
  }

  return `${lines.join('\n')}\n`
}

/** Terminal summary for `pnpm eval`. */
export function renderConsole(report: EvalReport): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`  pass rate      : ${report.passed}/${report.taskCount} (${report.passRate}%)`)
  lines.push(
    `  median latency : ${(report.medianLatencyMs / 1000).toFixed(1)}s   p95 ${(report.p95LatencyMs / 1000).toFixed(1)}s`,
  )
  lines.push(
    `  median cost    : ${formatUsd(report.medianCostUsd)}   total ${formatUsd(report.totalCostUsd)}`,
  )
  lines.push(`  median turns   : ${report.medianTurns}`)
  lines.push(`  cache savings  : ${report.cacheSavingsPercent}%`)
  if (report.injectionBlockRate !== null) {
    lines.push(`  injection block: ${report.injectionBlockRate}%`)
  }
  lines.push('')
  lines.push('  by class:')
  for (const [name, stats] of Object.entries(report.byClass).sort()) {
    const bar = '█'.repeat(Math.round(stats.passRate / 10)).padEnd(10, '·')
    lines.push(`    ${name.padEnd(24)} ${bar} ${stats.passed}/${stats.total}`)
  }
  return lines.join('\n')
}
