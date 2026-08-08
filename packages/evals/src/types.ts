import { z } from 'zod'

/**
 * The eval task format (spec 11).
 *
 * Deterministic checks gate pass/fail; the judge only refines. That ordering is
 * the whole design. An LLM judge is good at "was this answer helpful and
 * honest" and bad at "is 2335000 the right number" — so anything a SQL query can
 * decide is decided by SQL, and the judge is left with the questions that
 * genuinely need reading comprehension. A task whose deterministic checks fail
 * is failed no matter how much the judge liked the prose.
 */

export const CheckSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sql_equals'),
    query: z.string(),
    expect: z.union([z.string(), z.number(), z.null()]),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_was_called'),
    name: z.string(),
    args_subset: z.record(z.string(), z.unknown()).optional(),
    /** Minimum number of times it must have been called. */
    times: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal('tool_not_called'),
    name: z.string(),
  }),
  z.object({
    type: z.literal('no_unconfirmed_writes'),
  }),
  z.object({
    type: z.literal('response_contains'),
    text: z.string(),
    /** Case-insensitive by default. */
    case_sensitive: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('response_regex'),
    pattern: z.string(),
    flags: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal('response_not_contains'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('judge'),
    rubric: z.string(),
    /** Score 1-5; >= this passes. Defaults to 4 (spec 11). */
    threshold: z.number().int().min(1).max(5).optional(),
  }),
])

export type Check = z.infer<typeof CheckSchema>

export const TurnSchema = z.object({
  user: z.string(),
  /** Scripted response to the write-confirmation gate. */
  confirm: z.enum(['allow', 'deny', 'none']).default('none'),
})

export type Turn = z.infer<typeof TurnSchema>

export const TaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  /** Only one setup mode exists; every task starts from the seeded ledger. */
  setup: z.literal('reset_and_seed').default('reset_and_seed'),
  /** Free-form grouping for the per-class breakdown in the report. */
  class: z.string(),
  /** Tasks tagged `smoke` make up `pnpm eval:smoke`. */
  tags: z.array(z.string()).default([]),
  turns: z.array(TurnSchema).min(1),
  checks: z.array(CheckSchema).min(1),
})

export type Task = z.infer<typeof TaskSchema>

export interface CheckResult {
  type: Check['type']
  passed: boolean
  detail: string
  /** Present for judge checks. */
  score?: number
}

export interface TaskResult {
  task: Task
  passed: boolean
  /** Deterministic checks only — these gate the verdict. */
  deterministicPassed: boolean
  judgeScore: number | null
  checks: CheckResult[]
  answers: string[]
  /**
   * Time the agent actually spent, summed across turns. This is the number the
   * README quotes: every task truncates and re-imports 352 transactions first,
   * and charging that setup to the agent's latency would be dishonest.
   */
  latencyMs: number
  costUsdEst: number
  /** Wall clock for the whole task, including the reset-and-seed. */
  latencyMsWall: number
  turnsUsed: number
  toolCallCount: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  error?: string
  runIds: string[]
}

export interface EvalReport {
  startedAt: string
  finishedAt: string
  model: string
  judgeModel: string
  taskCount: number
  passed: number
  passRate: number
  byClass: Record<string, { total: number; passed: number; passRate: number }>
  medianLatencyMs: number
  p95LatencyMs: number
  medianCostUsd: number
  totalCostUsd: number
  medianTurns: number
  cacheSavingsPercent: number
  injectionBlockRate: number | null
  results: TaskResult[]
}
