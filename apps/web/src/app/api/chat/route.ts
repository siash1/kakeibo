import { ContextManager, createAdapter, env, loadEnv, runTurn } from '@kakeibo/core'
import {
  createRegistry,
  DbMemoryStore,
  DbTracer,
  DEV_OWNER_ID,
  KNOWN_CATEGORIES,
} from '@kakeibo/ledger'
import { getHistory, setHistory } from '@/lib/session'

/**
 * POST /api/chat -> Server-Sent Events (spec 13).
 *
 * Events: token, tool_call, tool_result, confirm_request, turn_end, error.
 *
 * The confirmation flow is the reason this is SSE and not a plain JSON
 * response: the loop stops mid-turn waiting for a human, and the client needs
 * to see that happen.
 *
 * The turn runs under the `suspend` policy: a batch containing a write ends the
 * turn and hands back what it was about to do, rather than blocking on a promise
 * that a second HTTP request resolves. That promise worked on one long-running
 * process and cannot work on serverless, where /api/chat and /api/confirm are
 * different invocations. Persisting the suspended state and resuming from it is
 * Plan B task 10; until then the card is emitted and answering it is a no-op.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

loadEnv()

// One fixed owner until Plan B introduces sessions; this is the single line
// each surface has to change then.
const owner = DEV_OWNER_ID
const registry = createRegistry(owner)
const tracer = new DbTracer(owner)
const memory = new DbMemoryStore(owner)
const contextManager = new ContextManager()

function describeCause(error: unknown): string {
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

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { message?: string; sessionId?: string }
  const message = body.message?.trim()
  const sessionId = body.sessionId ?? 'default'

  if (!message) {
    return Response.json({ error: 'message is required' }, { status: 400 })
  }

  const config = env()
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send = (event: string, data: unknown) => {
        if (closed) return
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      // The browser going away must not leave a turn waiting on a confirmation
      // that can no longer be answered.
      const abort = new AbortController()
      request.signal.addEventListener('abort', () => abort.abort())

      try {
        const result = await runTurn({
          userMessage: message,
          history: getHistory(sessionId),
          adapter: createAdapter(),
          registry,
          tracer,
          model: config.AGENT_MODEL,
          summarizerModel: config.SUMMARIZER_MODEL,
          channel: 'web',
          memory,
          knownCategories: KNOWN_CATEGORIES,
          contextManager,
          signal: abort.signal,
          confirmPolicy: { mode: 'suspend' },
          onText: (delta) => send('token', { delta }),
          onToolCall: (call) => send('tool_call', call),
          onToolResult: (toolResult) => send('tool_result', toolResult),
        })

        for (const item of result.suspended?.pending ?? []) {
          send('confirm_request', { ...item, tier: 'write' })
        }

        // A suspended turn's history ends on the assistant message whose tool
        // calls are still unanswered. Storing it would make the next turn open
        // with an unanswered batch, which is a hard 400 from the provider.
        if (result.status !== 'suspended') setHistory(sessionId, result.history)

        send('turn_end', {
          run_id: result.runId,
          status: result.status,
          usage: result.usage,
          cost_usd_est: result.costUsdEst,
          uncached_cost_usd_est: result.uncachedCostUsdEst,
          latency_ms: result.latencyMs,
          iterations: result.iterations,
          evictions: result.evictions,
          ...(result.errorMessage ? { error: result.errorMessage } : {}),
        })
      } catch (error) {
        // Drizzle wraps the driver error, and the wrapper's message is the SQL
        // rather than the reason. Walking the cause chain is the difference
        // between "Failed query: insert into..." and an actionable message.
        send('error', { message: describeCause(error) })
      } finally {
        closed = true
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
