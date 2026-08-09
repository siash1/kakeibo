import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvalReport } from '@kakeibo/evals'

/**
 * The last eval run, as committed to git.
 *
 * Reading the artefact rather than running anything is the point (spec 13). An
 * eval run costs real money and takes minutes; `evals/report/latest.json` is the
 * deliverable, and every figure the landing page and `/evals` show comes out of
 * it. That is CLAUDE.md rule 3 applied to the UI: a number no script in this
 * repo can reproduce does not appear on a page either.
 *
 * Both callers need the same file, and they need it to be the same file — a
 * landing page quoting a pass rate the eval report disagrees with is worse than
 * a landing page with no pass rate on it.
 */
export function loadReport(): EvalReport | null {
  try {
    const root = process.cwd().replace(/\/(packages|apps)\/[^/]+$/, '')
    return JSON.parse(
      readFileSync(join(root, 'evals', 'report', 'latest.json'), 'utf8'),
    ) as EvalReport
  } catch {
    return null
  }
}

/**
 * One recorded exchange, for the landing page to show without spending a turn.
 *
 * Everything here is read out of the eval report; nothing is composed for the
 * page. That constraint is what makes the section worth having — the landing's
 * claim is "this is the thing itself, recorded", and a demo with a written-for-
 * marketing answer in it would be a claim the repo cannot reproduce.
 *
 * It is also why the confirmation is shown by its recorded *check* rather than
 * as a filled-in slip: the report stores that the gate fired and that the run
 * allowed it, but not the summary line the visitor saw. Rendering a plausible
 * slip would be inventing the one screen this product exists to be trusted
 * about.
 */
export interface RecordedExchange {
  taskId: string
  description: string
  question: string
  /** Tool names in the order the recorded run actually called them. */
  toolNames: string[]
  answer: string
  /** The recorded verdict of the `no_unconfirmed_writes` check, when it ran. */
  gate: { detail: string } | null
  latencyMs: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  costUsd: number
}

/** `search_transactions called 1x (needed 1); all calls: a, b` -> `['a','b']` */
function parseCalls(detail: string): string[] {
  const marker = detail.indexOf('all calls:')
  if (marker < 0) return []
  return detail
    .slice(marker + 'all calls:'.length)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

/**
 * The exchange the landing page replays.
 *
 * Preferred by id, because one task in the suite happens to exercise the whole
 * product in a single turn — a read, a proposed write, the gate, and a selective
 * result — and picking it deliberately beats picking whichever task sorts first.
 * The fallbacks keep the page working against a report that no longer has it.
 */
const PREFERRED = 'categorize-groceries-only'

export function recordedExchange(report: EvalReport): RecordedExchange | null {
  const candidates = report.results.filter((result) => result.passed && result.answers.length > 0)
  const chosen =
    candidates.find((result) => result.task.id === PREFERRED) ??
    candidates.find((result) => result.task.turns.some((turn) => turn.confirm === 'allow')) ??
    candidates[0]

  if (!chosen) return null

  const question = chosen.task.turns[0]?.user
  const answer = chosen.answers[0]
  if (!question || !answer) return null

  const called = chosen.checks
    .filter((check) => check.type === 'tool_was_called')
    .flatMap((check) => parseCalls(check.detail ?? ''))
  const gate = chosen.checks.find((check) => check.type === 'no_unconfirmed_writes')

  return {
    taskId: chosen.task.id,
    description: chosen.task.description,
    question,
    toolNames: [...new Set(called)],
    answer,
    gate: gate?.detail ? { detail: gate.detail } : null,
    latencyMs: chosen.latencyMs,
    inputTokens: chosen.inputTokens,
    cachedTokens: chosen.cachedTokens,
    outputTokens: chosen.outputTokens,
    costUsd: chosen.costUsdEst,
  }
}
