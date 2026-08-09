import { loadEnv, runTurn } from '@kakeibo/core'
import {
  consumeQuota,
  createConversation,
  ensureLedger,
  latestConversation,
  loadHistory,
} from '@kakeibo/ledger'
import { requestGeo } from '@/lib/geo'
import { requestIpHash, resolveOwner } from '@/lib/owner'
import { agentDependencies, completeTurn, quotaRefusal, sseResponse } from '@/lib/turn'

/**
 * POST /api/chat -> Server-Sent Events (spec 13).
 *
 * Events: token, tool_call, tool_result, confirm_request, turn_end, error.
 *
 * The turn runs under the `suspend` policy. A batch containing a write ends
 * this request, handing back what it was about to do; `/api/confirm` picks the
 * turn up from the database and streams the rest. Nothing is awaited across
 * invocations any more, which is what makes the write gate work on serverless
 * at all — there, the two routes are different functions with no shared heap.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

loadEnv()

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { message?: string; conversationId?: string }
  const message = body.message?.trim()
  if (!message) return Response.json({ error: 'message is required' }, { status: 400 })

  const { owner, isAnonymous, setCookie } = await resolveOwner(request)

  const verdict = await consumeQuota({
    owner,
    ipHash: requestIpHash(request),
    isAnonymous,
    kind: 'message',
  })
  if (!verdict.allowed) return quotaRefusal(verdict.reason, setCookie)

  return sseResponse({ setCookie }, async (send) => {
    // The demo ledger is cloned here rather than on page load, so a crawler or
    // a bounce costs nothing. It is a no-op once the visitor has one.
    await ensureLedger(owner)

    const conversation =
      (body.conversationId ? { id: body.conversationId } : undefined) ??
      (await latestConversation(owner)) ??
      (await createConversation(owner))

    // loadHistory is owner-scoped, so a conversation id belonging to someone
    // else reads as an empty thread rather than as theirs.
    const history = await loadHistory(owner, conversation.id)

    const abort = new AbortController()
    request.signal.addEventListener('abort', () => abort.abort())

    const result = await runTurn({
      ...agentDependencies(owner, requestGeo(request)),
      userMessage: message,
      history,
      signal: abort.signal,
      confirmPolicy: { mode: 'suspend' },
      onText: (delta) => send('token', { delta }),
      onToolCall: (call) => send('tool_call', call),
      onToolResult: (toolResult) => send('tool_result', toolResult),
    })

    await completeTurn(owner, conversation.id, result, send)
  })
}
