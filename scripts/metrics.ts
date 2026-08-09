import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CanonicalMessage,
  ContextManager,
  env,
  estimateTokens,
  formatUsd,
  GeminiAdapter,
  loadEnv,
  SYSTEM_PROMPT,
} from '@kakeibo/core'
import type { EvalReport } from '@kakeibo/evals'
import {
  cacheStats,
  closeDb,
  createRegistry,
  DEV_OWNER_ID,
  searchTransactions,
} from '@kakeibo/ledger'

/**
 * `pnpm metrics` — prints every number the README claims, from the artefacts
 * that produced them (spec 18).
 *
 * The rule this enforces is spec 2.3: no figure goes in the README that the
 * repo cannot reproduce. Anything this script cannot compute is printed as
 * "not measured" rather than guessed.
 */

loadEnv()

const root = process.cwd().replace(/\/(packages|apps)\/[^/]+$/, '')

async function main(): Promise<void> {
  const config = env()
  const registry = createRegistry(DEV_OWNER_ID)

  console.log('kakeibo metrics\n')

  // --- Eval report ---------------------------------------------------------
  const reportPath = join(root, 'evals', 'report', 'latest.json')
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as EvalReport
    console.log('  evals')
    console.log(
      `    pass rate            : ${report.passed}/${report.taskCount} (${report.passRate}%)`,
    )
    console.log(`    median turn latency  : ${(report.medianLatencyMs / 1000).toFixed(1)}s`)
    console.log(`    p95 turn latency     : ${(report.p95LatencyMs / 1000).toFixed(1)}s`)
    console.log(`    median cost per task : ${formatUsd(report.medianCostUsd)}`)
    console.log(`    total run cost       : ${formatUsd(report.totalCostUsd)}`)
    console.log(`    cache savings (evals): ${report.cacheSavingsPercent}%`)
    console.log(`    injection block rate : ${report.injectionBlockRate ?? 'not measured'}%`)
    console.log('    by class:')
    for (const [name, stats] of Object.entries(report.byClass).sort()) {
      console.log(`      ${name.padEnd(22)} ${stats.passed}/${stats.total}`)
    }
  } else {
    console.log('  evals: no report — run `pnpm eval`')
  }

  // --- Lifetime cache stats from the trace tables --------------------------
  console.log('\n  caching (all traced runs in this database)')
  const cache = await cacheStats(DEV_OWNER_ID)
  console.log(`    runs traced          : ${cache.runs}`)
  console.log(
    `    prompt tokens cached : ${cache.cachedTokens.toLocaleString()} / ${cache.inputTokens.toLocaleString()} = ${cache.savingsPercent}%`,
  )

  // --- Context-manager estimate error --------------------------------------
  //
  // The context manager uses a real countTokens at turn start and a chars/4
  // estimate between counts. This measures how wrong the cheap estimate is over
  // histories built from actual ledger content, which is the only fair test —
  // JSON-heavy tool results tokenise very differently from prose.
  console.log('\n  context estimate error (heuristic vs real countTokens)')
  const adapter = new GeminiAdapter()
  const manager = new ContextManager()
  const tools = registry.declarations()
  const histories = await buildHistories()
  const errors: number[] = []

  for (const [label, history] of histories) {
    const estimate = estimateTokens(SYSTEM_PROMPT, history, tools)
    const real = await adapter.countTokens(config.AGENT_MODEL, SYSTEM_PROMPT, history, tools)
    const error = ((estimate - real) / real) * 100
    errors.push(error)
    console.log(
      `    ${label.padEnd(22)} est ${String(estimate).padStart(6)}  real ${String(real).padStart(6)}  ${error >= 0 ? '+' : ''}${error.toFixed(1)}%`,
    )
  }
  const meanAbs = errors.reduce((sum, e) => sum + Math.abs(e), 0) / errors.length
  console.log(`    mean absolute error  : ${meanAbs.toFixed(1)}%`)
  void manager

  // --- Repo facts ----------------------------------------------------------
  console.log('\n  repo')
  console.log(`    tools                : ${registry.list().length}`)
  console.log(
    `    core loop            : ${loc('packages/core/src/loop.ts')} lines (${codeLoc('packages/core/src/loop.ts')} excluding comments and blanks)`,
  )
  console.log(`    eval tasks           : ${count('grep -h "^- id:" evals/tasks/*.yaml | wc -l')}`)
  console.log(
    `    tests                : ${count('grep -rhoE "^\\s*(it|test)\\(" packages apps tests --include=*.test.ts | wc -l')} across ${count('ls packages/*/src/**/*.test.ts packages/*/src/*.test.ts apps/*/src/**/*.test.ts tests/*.test.ts 2>/dev/null | sort -u | wc -l')} files`,
  )
  // This is a static grep for `it(`/`test(` declarations, not vitest's runtime
  // count — `pnpm test` prints a higher number wherever a test is generated in
  // a loop (packages/ledger/src/isolation.test.ts builds several from a
  // table). The README's own Tests row cites `pnpm test` for exactly that
  // reason; this figure and that one are expected to disagree, and neither is
  // wrong.
  console.log(
    '                           (static count of test declarations; run `pnpm test` for the number vitest actually executes, which counts tests generated in a loop separately)',
  )
  console.log(`    fixtures             : ${count('ls fixtures/*.json 2>/dev/null | wc -l')}`)

  await closeDb()
  console.log()
}

/** Realistic histories: short, medium and long conversations over real data. */
async function buildHistories(): Promise<[string, CanonicalMessage[]][]> {
  const rows = await searchTransactions(DEV_OWNER_ID, { limit: 40 })
  const toolResult = JSON.stringify({ count: rows.length, transactions: rows }, null, 2)

  const exchange = (n: number): CanonicalMessage[] => [
    { role: 'user', content: [{ type: 'text', text: `What did I spend in month ${n}?` }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: `c${n}`, name: 'search_transactions', input: { limit: 40 } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `c${n}`,
          name: 'search_transactions',
          content: toolResult,
        },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: `You spent a total in month ${n}.` }] },
  ]

  return [
    [
      '1 turn (prose only)',
      [
        {
          role: 'user',
          content: [{ type: 'text', text: 'What did I spend on groceries in March?' }],
        },
      ],
    ],
    ['1 turn (tool result)', exchange(1)],
    ['4 turns', [1, 2, 3, 4].flatMap(exchange)],
    ['12 turns', Array.from({ length: 12 }, (_, i) => exchange(i)).flat()],
  ]
}

function loc(path: string): number {
  return Number(
    execSync(`wc -l < ${join(root, path)}`)
      .toString()
      .trim(),
  )
}

function codeLoc(path: string): number {
  const text = readFileSync(join(root, path), 'utf8')
  let inBlock = false
  return text.split('\n').filter((line) => {
    const t = line.trim()
    if (t.startsWith('/*')) inBlock = true
    const wasInBlock = inBlock
    if (t.endsWith('*/')) inBlock = false
    return t.length > 0 && !wasInBlock && !t.startsWith('//')
  }).length
}

function count(command: string): string {
  try {
    return execSync(command, { cwd: root, shell: '/bin/bash' }).toString().trim()
  } catch {
    return '?'
  }
}

main().catch(async (error) => {
  console.error('metrics failed:', error instanceof Error ? error.message : error)
  await closeDb()
  process.exit(1)
})
