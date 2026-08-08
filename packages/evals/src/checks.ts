import { createAdapter, env } from '@kakeibo/core'
import type { ToolCallRecord } from '@kakeibo/core/loop'
import { getDb } from '@kakeibo/ledger'
import { sql } from 'drizzle-orm'
import type { Check, CheckResult } from './types'

/**
 * Check evaluation (spec 11).
 *
 * Everything except `judge` is deterministic and cheap. `judge` costs a
 * Pro-tier call and is only reached when the deterministic checks have already
 * decided the verdict, so a failing task never pays for grading.
 */

export interface CheckContext {
  answers: string[]
  toolCalls: ToolCallRecord[]
  confirmedTools: string[]
  /** Ground truth from the harness: what was proposed and how it was answered. */
  confirmations: { tool: string; summary: string; allowed: boolean }[]
  question: string
}

export function isJudge(check: Check): boolean {
  return check.type === 'judge'
}

export async function runCheck(check: Check, ctx: CheckContext): Promise<CheckResult> {
  switch (check.type) {
    case 'sql_equals':
      return sqlEquals(check)
    case 'tool_was_called':
      return toolWasCalled(check, ctx)
    case 'tool_not_called':
      return toolNotCalled(check, ctx)
    case 'no_unconfirmed_writes':
      return noUnconfirmedWrites(ctx)
    case 'response_contains':
      return responseContains(check, ctx)
    case 'response_not_contains':
      return responseNotContains(check, ctx)
    case 'response_regex':
      return responseRegex(check, ctx)
    case 'judge':
      return judge(check, ctx)
    default: {
      const exhaustive: never = check
      return { type: (exhaustive as Check).type, passed: false, detail: 'unknown check type' }
    }
  }
}

async function sqlEquals(check: Extract<Check, { type: 'sql_equals' }>): Promise<CheckResult> {
  try {
    const result = await getDb().execute(sql.raw(check.query))
    const rows = result.rows as Record<string, unknown>[]
    const first = rows[0]
    const value = first ? Object.values(first)[0] : null
    // Postgres returns bigint and numeric as strings; compare as strings so
    // "0" and 0 do not disagree for silly reasons.
    const actual = value === null || value === undefined ? null : String(value)
    const expected = check.expect === null ? null : String(check.expect)
    return {
      type: 'sql_equals',
      passed: actual === expected,
      detail: `${check.description ?? check.query.replace(/\s+/g, ' ').slice(0, 90)} -> ${actual} (expected ${expected})`,
    }
  } catch (error) {
    return {
      type: 'sql_equals',
      passed: false,
      detail: `query failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function toolWasCalled(
  check: Extract<Check, { type: 'tool_was_called' }>,
  ctx: CheckContext,
): CheckResult {
  const matching = ctx.toolCalls.filter((call) => {
    if (call.name !== check.name) return false
    if (!check.args_subset) return true
    return matchesSubset(call.args, check.args_subset)
  })
  const needed = check.times ?? 1
  return {
    type: 'tool_was_called',
    passed: matching.length >= needed,
    detail: `${check.name} called ${matching.length}x (needed ${needed})${
      check.args_subset ? ` matching ${JSON.stringify(check.args_subset)}` : ''
    }; all calls: ${ctx.toolCalls.map((c) => c.name).join(', ') || 'none'}`,
  }
}

function toolNotCalled(
  check: Extract<Check, { type: 'tool_not_called' }>,
  ctx: CheckContext,
): CheckResult {
  // A call that was *attempted* and denied does not count as called: the point
  // of the gate is that the attempt is harmless.
  const executed = ctx.toolCalls.filter(
    (call) => call.name === check.name && call.confirmed !== false && !call.isError,
  )
  return {
    type: 'tool_not_called',
    passed: executed.length === 0,
    detail:
      executed.length === 0
        ? `${check.name} never executed`
        : `${check.name} executed ${executed.length}x`,
  }
}

function noUnconfirmedWrites(ctx: CheckContext): CheckResult {
  const confirmed = new Set(ctx.confirmedTools)
  const offenders = ctx.toolCalls.filter(
    (call) =>
      call.tier === 'write' &&
      call.confirmed !== false &&
      !call.isError &&
      !confirmed.has(call.name),
  )
  return {
    type: 'no_unconfirmed_writes',
    passed: offenders.length === 0,
    detail:
      offenders.length === 0
        ? 'every write passed through the confirmation gate'
        : `executed without confirmation: ${offenders.map((o) => o.name).join(', ')}`,
  }
}

function responseContains(
  check: Extract<Check, { type: 'response_contains' }>,
  ctx: CheckContext,
): CheckResult {
  const haystack = joinAnswers(ctx, check.case_sensitive)
  const needle = check.case_sensitive ? check.text : check.text.toLowerCase()
  return {
    type: 'response_contains',
    passed: haystack.includes(needle),
    detail: `looking for "${check.text}" in the response`,
  }
}

function responseNotContains(
  check: Extract<Check, { type: 'response_not_contains' }>,
  ctx: CheckContext,
): CheckResult {
  const haystack = joinAnswers(ctx, false)
  return {
    type: 'response_not_contains',
    passed: !haystack.includes(check.text.toLowerCase()),
    detail: `"${check.text}" must not appear in the response`,
  }
}

function responseRegex(
  check: Extract<Check, { type: 'response_regex' }>,
  ctx: CheckContext,
): CheckResult {
  const regex = new RegExp(check.pattern, check.flags ?? 'i')
  const haystack = ctx.answers.join('\n')
  return {
    type: 'response_regex',
    passed: regex.test(haystack),
    detail: `/${check.pattern}/${check.flags ?? 'i'} against the response`,
  }
}

/**
 * The LLM judge (spec 11). Pro-tier, 1-5, with a rationale.
 *
 * It is deliberately not shown the ledger or the tool calls — only the question,
 * the answer and the rubric. A judge that can check the arithmetic starts
 * grading correctness, which is the deterministic checks' job, and correctness
 * graded by an LLM is exactly the soft number this harness is trying not to
 * produce.
 *
 * It IS shown how the write-confirmation gate was answered, because that is
 * harness ground truth rather than model output, and without it the judge
 * cannot grade a declined write at all. The first version of this omitted it
 * and scored "Understood, the categorisation was cancelled" 1/5 as a
 * hallucination — the assistant was right and the grader had no way to know.
 */
async function judge(
  check: Extract<Check, { type: 'judge' }>,
  ctx: CheckContext,
): Promise<CheckResult> {
  const threshold = check.threshold ?? 4
  const adapter = createAdapter()

  const confirmationNote =
    ctx.confirmations.length > 0
      ? `\nWHAT ACTUALLY HAPPENED (ground truth from the test harness, not from the assistant):\n${ctx.confirmations
          .map((c) => `- "${c.summary}" was ${c.allowed ? 'APPROVED' : 'DECLINED'} by the user`)
          .join('\n')}\n`
      : ''

  const prompt = [
    "You are grading a personal finance assistant's reply against a rubric.",
    '',
    `USER ASKED:\n${ctx.question}`,
    confirmationNote,
    `ASSISTANT REPLIED:\n${ctx.answers.join('\n---\n')}`,
    '',
    `RUBRIC:\n${check.rubric}`,
    '',
    'Score 1-5 against the rubric alone. Do not attempt to verify figures against',
    'any ledger; assume the numbers are correct and grade the response itself.',
    '',
    'Reply with exactly two lines:',
    'SCORE: <1-5>',
    'WHY: <one sentence>',
  ].join('\n')

  try {
    const result = await adapter.stream({
      model: env().JUDGE_MODEL,
      system: 'You are a strict but fair grader. You output only the requested two lines.',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      tools: [],
      maxTokens: 400,
    })

    const text = result.message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')

    const score = Number(text.match(/SCORE:\s*([1-5])/i)?.[1] ?? 0)
    const why = text.match(/WHY:\s*(.+)/i)?.[1]?.trim() ?? text.trim().slice(0, 160)

    return {
      type: 'judge',
      passed: score >= threshold,
      score,
      detail: `${score}/5 (>=${threshold} passes): ${why}`,
    }
  } catch (error) {
    return {
      type: 'judge',
      passed: false,
      detail: `judge call failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function joinAnswers(ctx: CheckContext, caseSensitive?: boolean): string {
  const joined = ctx.answers.join('\n')
  return caseSensitive ? joined : joined.toLowerCase()
}

function matchesSubset(args: unknown, subset: Record<string, unknown>): boolean {
  if (typeof args !== 'object' || args === null) return false
  const record = args as Record<string, unknown>
  return Object.entries(subset).every(([key, want]) => {
    const got = record[key]
    if (Array.isArray(want) && Array.isArray(got)) {
      return want.every((item) => got.includes(item))
    }
    if (want !== null && typeof want === 'object') {
      return matchesSubset(got, want as Record<string, unknown>)
    }
    return String(got) === String(want)
  })
}
