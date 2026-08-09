import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CanonicalMessage,
  createAdapter,
  env,
  InMemoryTracer,
  runTurn,
  type ToolCallRecord,
} from '@kakeibo/core'
import {
  closeDb,
  commitImport,
  createRegistry,
  DEV_OWNER_ID,
  ensureOwnerUser,
  ensureSeedAccounts,
  generateSeedData,
  getDb,
  KNOWN_CATEGORIES,
  minorToDecimalString,
  planImport,
  toCsv,
} from '@kakeibo/ledger'
import { sql } from 'drizzle-orm'
import { parse as parseYaml } from 'yaml'
import { isJudge, runCheck } from './checks'
import { type EvalReport, type Task, type TaskResult, TaskSchema } from './types'

/**
 * The eval runner (spec 11).
 *
 * Every task starts from `reset_and_seed`, which truncates and re-imports the
 * deterministic corpus. That is slower than sharing a database across tasks and
 * it is the only way the `sql_equals` checks can assert exact counts: a task
 * that categorises transactions would otherwise silently change the oracle for
 * every task after it.
 */

const seed = generateSeedData()
const seedCsv = toCsv(
  seed.rows.map((row) => ({
    date: row.date,
    description: row.description,
    amount: minorToDecimalString(row.amountMinor),
    category: row.csvCategory,
  })),
  ['date', 'description', 'amount', 'category'],
)

export function tasksDir(): string {
  return join(repoRoot(), 'evals', 'tasks')
}

export function repoRoot(): string {
  return process.cwd().replace(/\/(packages|apps)\/[^/]+$/, '')
}

export function loadTasks(filter?: string): Task[] {
  const dir = tasksDir()
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
  const tasks: Task[] = []

  for (const file of files.sort()) {
    const raw = parseYaml(readFileSync(join(dir, file), 'utf8'))
    const entries = Array.isArray(raw) ? raw : [raw]
    for (const entry of entries) {
      const parsed = TaskSchema.safeParse(entry)
      if (!parsed.success) {
        throw new Error(
          `${file}: invalid task "${(entry as { id?: string })?.id ?? '?'}": ${parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        )
      }
      tasks.push(parsed.data)
    }
  }

  if (!filter) return tasks
  return tasks.filter(
    (task) => task.id.includes(filter) || task.class === filter || task.tags.includes(filter),
  )
}

export async function resetAndSeed(): Promise<void> {
  await getDb().execute(
    sql`truncate table trace_events, trace_runs, postings, transactions, import_batches, budgets, rules, memories, accounts restart identity cascade`,
  )
  // owner_id references user(id), and the truncate above does not touch the
  // principal table — but a fresh database has never had one.
  await ensureOwnerUser(DEV_OWNER_ID)
  await ensureSeedAccounts(DEV_OWNER_ID)
  const { preview, resolved } = await planImport(
    DEV_OWNER_ID,
    'data/seed/transactions.csv',
    seedCsv,
    'sample',
  )
  await commitImport(DEV_OWNER_ID, 'data/seed/transactions.csv', resolved, preview, {
    deterministicIds: true,
  })
}

export async function runTask(task: Task, options: { model?: string } = {}): Promise<TaskResult> {
  const config = env()
  const model = options.model ?? config.AGENT_MODEL
  const startedWall = Date.now()

  await resetAndSeed()
  const startedAgent = Date.now()

  const adapter = createAdapter()
  const registry = createRegistry(DEV_OWNER_ID)
  const tracer = new InMemoryTracer()

  let history: CanonicalMessage[] = []
  const answers: string[] = []
  const toolCalls: ToolCallRecord[] = []
  const confirmedTools: string[] = []
  const confirmations: { tool: string; summary: string; allowed: boolean }[] = []
  const runIds: string[] = []
  let costUsdEst = 0
  let inputTokens = 0
  let outputTokens = 0
  let cachedTokens = 0
  let turnsUsed = 0
  let error: string | undefined

  try {
    for (const turn of task.turns) {
      const result = await runTurn({
        userMessage: turn.user,
        history,
        adapter,
        registry,
        tracer,
        model,
        summarizerModel: config.SUMMARIZER_MODEL,
        channel: 'eval',
        knownCategories: KNOWN_CATEGORIES,
        // The scripted answer to the write gate (spec 11). `none` denies,
        // because a task that did not say "allow" is asserting that nothing
        // should have needed approval in the first place.
        confirmPolicy: turn.confirm === 'allow' ? { mode: 'auto-allow' } : { mode: 'auto-deny' },
      })

      history = result.history
      answers.push(result.text)
      toolCalls.push(...result.toolCalls)
      // There is no callback under a policy, so proposals are read back from
      // toolCalls — which already records tier and the decision, and is what
      // no_unconfirmed_writes reasoned over anyway.
      for (const call of result.toolCalls) {
        if (call.tier !== 'write') continue
        const allowed = call.confirmed === true
        confirmations.push({ tool: call.name, summary: call.name, allowed })
        if (allowed) confirmedTools.push(call.name)
      }
      runIds.push(result.runId)
      costUsdEst += result.costUsdEst
      inputTokens += result.usage.inputTokens
      outputTokens += result.usage.outputTokens
      cachedTokens += result.usage.cachedTokens
      turnsUsed += result.iterations + 1

      if (result.status === 'error' || result.status === 'blocked') {
        error = `${result.status}: ${result.errorMessage ?? 'unknown'}`
      }
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
  }

  const ctx = {
    answers,
    toolCalls,
    confirmedTools,
    confirmations,
    question: task.turns.map((t) => t.user).join('\n'),
  }

  // Deterministic checks first and always. The judge is skipped entirely when
  // they have already failed the task — no point paying a Pro-tier call to
  // grade the prose of a wrong answer.
  const deterministic = task.checks.filter((check) => !isJudge(check))
  const deterministicResults = []
  for (const check of deterministic) {
    deterministicResults.push(await runCheck(check, ctx))
  }
  const deterministicPassed = deterministicResults.every((r) => r.passed) && !error

  const judgeChecks = task.checks.filter(isJudge)
  const judgeResults = []
  if (deterministicPassed) {
    for (const check of judgeChecks) {
      judgeResults.push(await runCheck(check, ctx))
    }
  } else {
    for (const check of judgeChecks) {
      judgeResults.push({
        type: check.type,
        passed: false,
        detail: 'skipped: deterministic checks already failed',
      })
    }
  }

  const checks = [...deterministicResults, ...judgeResults]
  const judgeScores = judgeResults
    .map((r) => r.score)
    .filter((s): s is number => typeof s === 'number')

  return {
    task,
    passed: deterministicPassed && judgeResults.every((r) => r.passed),
    deterministicPassed,
    judgeScore:
      judgeScores.length > 0 ? judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length : null,
    checks,
    answers,
    latencyMs: Date.now() - startedAgent,
    latencyMsWall: Date.now() - startedWall,
    costUsdEst,
    turnsUsed,
    toolCallCount: toolCalls.length,
    inputTokens,
    outputTokens,
    cachedTokens,
    ...(error ? { error } : {}),
    runIds,
  }
}

export interface RunOptions {
  model?: string
  filter?: string
  onProgress?: (result: TaskResult, index: number, total: number) => void
  injectionBlockRate?: number | null
}

export async function runEvals(options: RunOptions = {}): Promise<EvalReport> {
  const config = env()
  const startedAt = new Date().toISOString()
  const tasks = loadTasks(options.filter)

  if (tasks.length === 0) {
    throw new Error(`No tasks matched${options.filter ? ` filter "${options.filter}"` : ''}.`)
  }

  const results: TaskResult[] = []
  // Sequential: every task truncates and reseeds the same database, so running
  // two at once would have them fighting over the ledger.
  for (const [index, task] of tasks.entries()) {
    const result = await runTask(task, options.model ? { model: options.model } : {})
    results.push(result)
    options.onProgress?.(result, index, tasks.length)
  }

  const finishedAt = new Date().toISOString()
  const byClass: EvalReport['byClass'] = {}
  for (const result of results) {
    const entry = byClass[result.task.class] ?? { total: 0, passed: 0, passRate: 0 }
    entry.total++
    if (result.passed) entry.passed++
    entry.passRate = Math.round((entry.passed / entry.total) * 1000) / 10
    byClass[result.task.class] = entry
  }

  const passed = results.filter((r) => r.passed).length
  const totalIn = results.reduce((s, r) => s + r.inputTokens, 0)
  const totalCached = results.reduce((s, r) => s + r.cachedTokens, 0)

  return {
    startedAt,
    finishedAt,
    model: options.model ?? config.AGENT_MODEL,
    judgeModel: config.JUDGE_MODEL,
    taskCount: results.length,
    passed,
    passRate: Math.round((passed / results.length) * 1000) / 10,
    byClass,
    medianLatencyMs: Math.round(
      percentile(
        results.map((r) => r.latencyMs),
        50,
      ),
    ),
    p95LatencyMs: Math.round(
      percentile(
        results.map((r) => r.latencyMs),
        95,
      ),
    ),
    medianCostUsd: percentile(
      results.map((r) => r.costUsdEst),
      50,
    ),
    totalCostUsd: results.reduce((s, r) => s + r.costUsdEst, 0),
    medianTurns: percentile(
      results.map((r) => r.turnsUsed),
      50,
    ),
    cacheSavingsPercent: totalIn > 0 ? Math.round((totalCached / totalIn) * 1000) / 10 : 0,
    injectionBlockRate: options.injectionBlockRate ?? null,
    results,
  }
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]!
}

export { closeDb }
