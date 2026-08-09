import { loadEnv, runTurn } from '@kakeibo/core'
import { consumeQuota, takeSuspendedTurn } from '@kakeibo/ledger'
import { requestGeo } from '@/lib/geo'
import { requestIpHash, resolveOwner } from '@/lib/owner'
import { agentDependencies, completeTurn, quotaRefusal, sseResponse } from '@/lib/turn'

/**
 * POST /api/confirm -> Server-Sent Events.
 *
 * The second half of a turn that stopped at a write (spec 8.6.1, §6). It reads
 * the suspended state back, runs the approved writes, refuses the rest, and
 * streams the remainder of the turn on *this* response.
 *
 * Nothing here resolves a promise the other route is waiting on. That design
 * worked on one long-running process and cannot work on serverless, where
 * /api/chat and /api/confirm are separate invocations with no shared memory —
 * the confirm card would render, you would click allow, and the first request
 * would sit there until it timed out.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

loadEnv()

interface Decision {
  id: string
  allowed: boolean
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as {
    suspendedTurnId?: string
    decisions?: Decision[]
  }
  if (!body.suspendedTurnId || !Array.isArray(body.decisions)) {
    return Response.json({ error: 'suspendedTurnId and decisions are required' }, { status: 400 })
  }

  const { owner, isAnonymous, setCookie } = await resolveOwner(request)

  // A resume does not spend a message — that was charged when the turn started,
  // and a turn nobody can finish leaves a write dangling with no way to answer
  // for it. Blocking and the daily cap still apply: resuming calls the model.
  const verdict = await consumeQuota({
    owner,
    ipHash: requestIpHash(request),
    isAnonymous,
    kind: 'resume',
  })
  if (!verdict.allowed) return quotaRefusal(verdict.reason, setCookie)

  // Owner-scoped, and it deletes as it reads: a decision that could be replayed
  // is a write that could be run twice.
  const suspended = await takeSuspendedTurn(owner, body.suspendedTurnId)
  if (!suspended) {
    // Already answered, expired, or never theirs. Not an error worth failing
    // loudly on — the UI just needs to stop showing the card.
    return Response.json(
      { error: 'That confirmation is no longer waiting.', reason: 'gone' },
      { status: 410 },
    )
  }

  const decisions = body.decisions.map((decision) => ({
    id: String(decision.id),
    allowed: decision.allowed === true,
  }))

  return sseResponse({ setCookie }, async (send) => {
    const abort = new AbortController()
    request.signal.addEventListener('abort', () => abort.abort())

    const result = await runTurn({
      ...agentDependencies(owner, requestGeo(request)),
      // Empty: the message that started this turn is already inside the
      // suspended history, and appending it again would ask twice.
      userMessage: '',
      history: [],
      resume: { state: suspended.state, decisions },
      signal: abort.signal,
      confirmPolicy: { mode: 'suspend' },
      onText: (delta) => send('token', { delta }),
      onToolCall: (call) => send('tool_call', call),
      onToolResult: (toolResult) => send('tool_result', toolResult),
    })

    // The model may propose another write once it sees the first one's result,
    // in which case this suspends again and the client gets a second card.
    await completeTurn(owner, suspended.conversationId, result, send)
  })
}
