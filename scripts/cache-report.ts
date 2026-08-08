import {
  createAdapter,
  env,
  formatUsd,
  GeminiAdapter,
  lastExplicitCacheError,
  loadEnv,
  runTurn,
  SYSTEM_PROMPT,
} from '@kakeibo/core'
import { cacheStats, closeDb, createRegistry, DbTracer } from '@kakeibo/ledger'

/**
 * `pnpm cache:report` — measures context caching for real (spec 5.5, 18).
 *
 * Runs a short steady-state conversation and reports, per turn, how many prompt
 * tokens the provider served from cache. Both layers are in play:
 *
 *  - implicit caching, which needs nothing but a byte-stable prefix, and
 *  - explicit caching, which needs `caches.create` to have succeeded.
 *
 * The interesting output is the comparison. EXPLICIT_CACHE=0 disables the second
 * layer, so running this twice gives the delta the README quotes rather than an
 * assertion that caching "works".
 */

loadEnv()

const QUESTIONS = [
  'What did I spend on groceries in March 2025?',
  'And in April?',
  'How does that compare with dining over the same two months?',
  'What am I subscribed to?',
  'Anything unusual in May?',
]

interface TurnRow {
  n: number
  question: string
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  latencyMs: number
  costUsd: number
  uncachedCostUsd: number
}

async function main(): Promise<void> {
  const config = env()
  const adapter = createAdapter()
  const registry = createRegistry()
  const tracer = new DbTracer()

  const probe = new GeminiAdapter()
  const prefixTokens = await probe.countTokens(
    config.AGENT_MODEL,
    SYSTEM_PROMPT,
    [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    registry.declarations(),
  )

  console.log('kakeibo cache report')
  console.log(`  model          : ${config.AGENT_MODEL}`)
  console.log(
    `  explicit cache : ${config.EXPLICIT_CACHE ? 'enabled' : 'disabled (EXPLICIT_CACHE=0)'}`,
  )
  console.log(
    `  stable prefix  : ~${prefixTokens} tokens (system instruction + ${registry.list().length} tool declarations)`,
  )

  const cacheRef = config.EXPLICIT_CACHE
    ? await probe.ensureCache(config.AGENT_MODEL, SYSTEM_PROMPT, registry.declarations())
    : null
  if (config.EXPLICIT_CACHE) {
    console.log(
      `  cache resource : ${cacheRef ?? `not created — ${lastExplicitCacheError() ?? 'unknown reason'}`}`,
    )
  }
  console.log()

  const rows: TurnRow[] = []
  let history: Parameters<typeof runTurn>[0]['history'] = []

  for (const [index, question] of QUESTIONS.entries()) {
    const result = await runTurn({
      userMessage: question,
      history,
      adapter,
      registry,
      tracer,
      model: config.AGENT_MODEL,
      summarizerModel: config.SUMMARIZER_MODEL,
      channel: 'eval',
      confirm: async () => false, // read-only conversation; nothing should ask
    })
    history = result.history
    rows.push({
      n: index + 1,
      question,
      inputTokens: result.usage.inputTokens,
      cachedTokens: result.usage.cachedTokens,
      outputTokens: result.usage.outputTokens,
      latencyMs: result.latencyMs,
      costUsd: result.costUsdEst,
      uncachedCostUsd: result.uncachedCostUsdEst,
    })
  }

  console.log(
    `  ${'TURN'.padEnd(5)} ${'IN'.padStart(7)} ${'CACHED'.padStart(7)} ${'HIT%'.padStart(6)} ${'OUT'.padStart(6)} ${'LATENCY'.padStart(8)}  QUESTION`,
  )
  console.log(
    `  ${'-'.repeat(5)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(6)} ${'-'.repeat(6)} ${'-'.repeat(8)}  ${'-'.repeat(40)}`,
  )
  for (const row of rows) {
    const hit = row.inputTokens > 0 ? (row.cachedTokens / row.inputTokens) * 100 : 0
    console.log(
      `  ${String(row.n).padEnd(5)} ${String(row.inputTokens).padStart(7)} ${String(row.cachedTokens).padStart(7)}` +
        ` ${hit.toFixed(1).padStart(5)}% ${String(row.outputTokens).padStart(6)} ${`${(row.latencyMs / 1000).toFixed(1)}s`.padStart(8)}  ${row.question.slice(0, 44)}`,
    )
  }

  const totalIn = rows.reduce((s, r) => s + r.inputTokens, 0)
  const totalCached = rows.reduce((s, r) => s + r.cachedTokens, 0)
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0)
  const totalUncached = rows.reduce((s, r) => s + r.uncachedCostUsd, 0)

  // Turn 1 can never hit — there is nothing to hit yet. Steady state is what a
  // real conversation looks like, so it is reported separately and is the number
  // the README quotes.
  const steady = rows.slice(1)
  const steadyIn = steady.reduce((s, r) => s + r.inputTokens, 0)
  const steadyCached = steady.reduce((s, r) => s + r.cachedTokens, 0)

  console.log()
  console.log(
    `  all turns      : ${totalCached} / ${totalIn} prompt tokens cached = ${pct(totalCached, totalIn)}`,
  )
  console.log(
    `  steady state   : ${steadyCached} / ${steadyIn} prompt tokens cached = ${pct(steadyCached, steadyIn)}  <- headline`,
  )
  console.log(
    `  cost           : ${formatUsd(totalCost)} vs ${formatUsd(totalUncached)} uncached (${pct(totalUncached - totalCost, totalUncached)} saved)`,
  )

  const lifetime = await cacheStats()
  console.log(
    `  lifetime (db)  : ${lifetime.cachedTokens} / ${lifetime.inputTokens} across ${lifetime.runs} traced runs = ${lifetime.savingsPercent}%`,
  )

  if (totalCached === 0) {
    console.log()
    console.log('  0% cached. Hunt the invalidator: byte-diff two serialised requests and look for')
    console.log('  anything varying in the prefix — a timestamp in the system instruction, tool')
    console.log(
      '  declarations serialised in a different key order, or memories injected too early.',
    )
  }

  await closeDb()
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : 'n/a'
}

main().catch(async (error) => {
  console.error('cache report failed:', error instanceof Error ? error.message : error)
  await closeDb()
  process.exit(1)
})
