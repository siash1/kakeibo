import type { CanonicalMessage, ConfirmRequest } from '@kakeibo/core'

/**
 * Single-process, single-user session state (spec 13).
 *
 * There are no accounts and no multi-tenancy in kakeibo, so a module-level Map
 * is the honest amount of machinery. Two things live here:
 *
 *  - conversation history, so the browser does not have to round-trip the whole
 *    canonical message array (which carries thought signatures and correlation
 *    IDs that have no business being editable by a client), and
 *
 *  - pending confirmations. The loop pauses inside a write-tier tool and awaits
 *    a promise; the SSE stream emits `confirm_request`; the UI renders a card;
 *    POST /api/confirm resolves that promise and the loop continues. The promise
 *    is the join between two HTTP requests, which is why it cannot be a local.
 */

interface PendingConfirm {
  request: ConfirmRequest
  resolve: (allowed: boolean) => void
  createdAt: number
}

/**
 * Stashed on globalThis, not in module scope.
 *
 * `/api/chat` and `/api/confirm` are separate route handlers, and Next bundles
 * them separately — module-level state is NOT reliably shared between them, and
 * dev HMR re-evaluates modules on top of that. With a plain module-level Map the
 * confirmation posted to one route lands in a different Map from the one the
 * chat route is awaiting, and the turn hangs until its timeout. Symptom: the
 * confirm card renders, you click allow, and nothing happens for five minutes.
 *
 * globalThis is per-process, which is exactly the scope this state wants.
 */
interface SessionStore {
  histories: Map<string, CanonicalMessage[]>
  pending: Map<string, PendingConfirm>
}

const globalStore = globalThis as typeof globalThis & { __kakeibo?: SessionStore }

function sessionStore(): SessionStore {
  if (!globalStore.__kakeibo) {
    globalStore.__kakeibo = {
      histories: new Map<string, CanonicalMessage[]>(),
      pending: new Map<string, PendingConfirm>(),
    }
  }
  return globalStore.__kakeibo
}

const store: SessionStore = sessionStore()

const { histories, pending } = store

/** Abandoned confirmations must not pin a turn open forever. */
const CONFIRM_TIMEOUT_MS = 5 * 60_000

export function getHistory(sessionId: string): CanonicalMessage[] {
  return histories.get(sessionId) ?? []
}

export function setHistory(sessionId: string, history: CanonicalMessage[]): void {
  histories.set(sessionId, history)
}

export function clearHistory(sessionId: string): void {
  histories.delete(sessionId)
}

export function awaitConfirmation(request: ConfirmRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(request.id)) {
        // No answer is a denial. For a tool that changes the ledger there is no
        // other safe reading.
        resolve(false)
      }
    }, CONFIRM_TIMEOUT_MS)

    pending.set(request.id, {
      request,
      createdAt: Date.now(),
      resolve: (allowed) => {
        clearTimeout(timer)
        resolve(allowed)
      },
    })
  })
}

export function resolveConfirmation(id: string, allowed: boolean): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  pending.delete(id)
  entry.resolve(allowed)
  return true
}

/** Denies everything outstanding — used when a client disconnects mid-turn. */
export function denyAllPending(): void {
  for (const [id, entry] of pending) {
    pending.delete(id)
    entry.resolve(false)
  }
}
