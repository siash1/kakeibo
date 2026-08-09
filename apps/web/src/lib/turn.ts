import { ContextManager, createAdapter, env, type TurnResult } from '@kakeibo/core'
import type { RunGeo } from '@kakeibo/core/trace'
import {
  createRegistry,
  DbMemoryStore,
  DbTracer,
  KNOWN_CATEGORIES,
  type OwnerId,
  type QuotaReason,
  replaceHistory,
  saveSuspendedTurn,
} from '@kakeibo/ledger'

/**
 * The parts of a turn both `/api/chat` and `/api/confirm` need.
 *
 * They are two halves of one turn — the second picks up where the first
 * suspended — so the streaming, the persistence and the closing event have to
 * be identical or the client sees a different shape depending on whether a
 * write happened to be involved.
 */

export type Send = (event: string, data: unknown) => void

/** Per-request, not per-process: every one of these is bound to one owner. */
export function agentDependencies(owner: OwnerId, geo?: RunGeo) {
  const config = env()
  return {
    adapter: createAdapter(),
    registry: createRegistry(owner),
    tracer: new DbTracer(owner, geo),
    memory: new DbMemoryStore(owner),
    contextManager: new ContextManager(),
    model: config.AGENT_MODEL,
    summarizerModel: config.SUMMARIZER_MODEL,
    channel: 'web' as const,
    knownCategories: KNOWN_CATEGORIES,
  }
}

/**
 * Persists what the turn produced and emits the event that closes it.
 *
 * A suspended turn deliberately stores no history: it ends on an assistant
 * message whose tool calls are unanswered, and opening the next turn with that
 * shape is a hard 400 from the provider. The whole state goes to
 * `suspended_turns` instead, and resume writes the finished turn in one go.
 */
export async function completeTurn(
  owner: OwnerId,
  conversationId: string,
  result: TurnResult,
  send: Send,
): Promise<void> {
  let suspendedTurnId: string | undefined

  if (result.status === 'suspended' && result.suspended) {
    suspendedTurnId = await saveSuspendedTurn(owner, conversationId, result.suspended)
    for (const item of result.suspended.pending) {
      send('confirm_request', { ...item, tier: 'write', suspended_turn_id: suspendedTurnId })
    }
  } else {
    await replaceHistory(owner, conversationId, result.history)
  }

  send('turn_end', {
    run_id: result.runId,
    conversation_id: conversationId,
    status: result.status,
    usage: result.usage,
    cost_usd_est: result.costUsdEst,
    uncached_cost_usd_est: result.uncachedCostUsdEst,
    latency_ms: result.latencyMs,
    iterations: result.iterations,
    evictions: result.evictions,
    ...(suspendedTurnId ? { suspended_turn_id: suspendedTurnId } : {}),
    ...(result.errorMessage ? { error: result.errorMessage } : {}),
  })
}

/**
 * Drizzle wraps the driver error and the wrapper's message is the SQL rather
 * than the reason. Walking the cause chain is the difference between "Failed
 * query: insert into..." and something a person can act on.
 */
export function describeCause(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const detail = (current as { detail?: string }).detail
    const code = (current as { code?: string }).code
    parts.push(
      [current.message, code ? `code=${code}` : '', detail ? `detail=${detail}` : '']
        .filter(Boolean)
        .join(' '),
    )
    current = (current as { cause?: unknown }).cause
  }
  return parts.join('  <- ') || String(error)
}

/** Wraps a turn in the SSE envelope, forwarding a session cookie if one was minted. */
export function sseResponse(
  options: { setCookie?: string | undefined },
  body: (send: Send) => Promise<void>,
): Response {
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send: Send = (event, data) => {
        if (closed) return
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      try {
        await body(send)
      } catch (error) {
        send('error', { message: describeCause(error) })
      } finally {
        closed = true
        controller.close()
      }
    },
  })

  const headers = new Headers({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx and friends buffer by default, which turns a stream into one late
    // blob and makes the confirmation card appear after the turn is over.
    'X-Accel-Buffering': 'no',
  })
  if (options.setCookie) headers.append('Set-Cookie', options.setCookie)

  return new Response(stream, { headers })
}

/**
 * A refused turn, as JSON rather than a stream.
 *
 * 503 with a machine-readable reason, because the UI's job here is to fall back
 * to the replayed-fixture demo with an honest banner rather than to show a
 * generic error (spec §5). The reason is what tells it which banner.
 */
export function quotaRefusal(reason: QuotaReason, setCookie?: string): Response {
  const messages: Record<QuotaReason, string> = {
    blocked: 'This session has been paused by the operator.',
    owner_quota: 'You have reached today’s message limit for this session.',
    ip_quota: 'This network has reached today’s message limit.',
    daily_cap: 'kakeibo has reached its daily model budget. Live chat resumes tomorrow.',
  }
  const response = Response.json({ error: messages[reason], reason }, { status: 503 })
  if (setCookie) response.headers.append('Set-Cookie', setCookie)
  return response
}
