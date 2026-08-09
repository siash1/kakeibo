import type { ConfirmFn } from './registry'
import type { CanonicalMessage, ToolResultBlock, Usage } from './types'

/**
 * How this turn answers the write-confirmation gate.
 *
 * The gate used to be a single callback the loop awaited. That works when the
 * decider lives in the same process — the CLI's readline prompt, an eval
 * script — and cannot work when it is a browser on the far side of a second
 * HTTP request: on serverless, /api/chat and /api/confirm are different
 * invocations with no shared memory to await across.
 *
 * Making the strategy explicit lets one loop serve both without a flag that
 * quietly means "do not actually call the callback you were given".
 */
export type ConfirmPolicy =
  /** Block in-process. The CLI. */
  | { mode: 'inline'; confirm: ConfirmFn }
  /** Approve without asking. MCP with ALLOW_WRITES=1; eval turns marked allow. */
  | { mode: 'auto-allow' }
  /** Refuse without asking. Eval turns marked deny or none. */
  | { mode: 'auto-deny' }
  /** Stop the turn and hand the decision back to the caller. The web. */
  | { mode: 'suspend' }

/** One write the model proposed and a human has not yet ruled on. */
export interface PendingConfirmation {
  /** The tool_use id, so a decision can be matched back without extra plumbing. */
  id: string
  tool: string
  args: unknown
  /** One line, in the user's terms, describing what will change. */
  summary: string
}

/**
 * Everything needed to pick a turn back up in a different process.
 *
 * `usage` and `costUsdEst` are carried deliberately. The model calls made
 * before the pause are real spend, and a resumed turn that started its totals
 * at zero would leave them out of the trace — which is exactly the spend the
 * budget cap most needs to see, since turns involving a confirmation are the
 * expensive ones.
 */
export interface SuspendedState {
  runId: string
  /** Messages up to and including the assistant turn that requested the tools. */
  history: CanonicalMessage[]
  /** Read-tier results already executed, so resume does not re-run them. */
  completedResults: ToolResultBlock[]
  pending: PendingConfirmation[]
  usage: Usage
  costUsdEst: number
  iterations: number
}

export interface ResumeInput {
  state: SuspendedState
  decisions: { id: string; allowed: boolean }[]
}

export function isWritePending(state: SuspendedState): boolean {
  return state.pending.length > 0
}
