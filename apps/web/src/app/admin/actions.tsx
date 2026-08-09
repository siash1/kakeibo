'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Badge } from '@/components/ui'
import { cn } from '@/lib/cn'

/**
 * The two operator writes (spec §9.4), both client components because a
 * server component cannot handle a click.
 *
 * Neither guesses at the new state locally: both POST to the existing
 * `/api/admin/action` route and then call `router.refresh()` so the server
 * components re-read from the database. The panels are computed server-side —
 * a local optimistic guess would just be a second opinion that can disagree
 * with the next render.
 */

async function postAction(body: unknown): Promise<void> {
  const response = await fetch('/api/admin/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`admin action failed: ${response.status}`)
  }
}

/** The site-wide live-chat pause switch, shown next to the budget panel. */
export function OperatorActions({ paused }: { paused: boolean }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  const toggle = async () => {
    setPending(true)
    try {
      await postAction({ action: 'pause_live_chat', paused: !paused })
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-ink-800 bg-ink-900/60 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-ink-500">live chat</span>
        <Badge tone={paused ? 'warn' : 'ok'}>{paused ? 'paused' : 'running'}</Badge>
      </div>
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        className="rounded border border-ink-700 px-3 py-1 font-mono text-xs text-ink-300 transition-colors hover:border-accent-dim hover:text-accent disabled:opacity-50"
      >
        {pending ? 'working…' : paused ? 'unpause' : 'pause'}
      </button>
    </div>
  )
}

/** Per-row block/unblock button in the users table. */
export function BlockButton({ ownerId, blocked }: { ownerId: string; blocked: boolean }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  const toggle = async () => {
    setPending(true)
    try {
      await postAction({ action: 'block_owner', ownerId, blocked: !blocked })
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      className={cn(
        'rounded border px-2 py-0.5 font-mono text-[11px] transition-colors disabled:opacity-50',
        blocked
          ? 'border-ink-700 text-ink-300 hover:border-accent-dim hover:text-accent'
          : 'border-danger/40 text-danger hover:bg-danger/10',
      )}
    >
      {pending ? '…' : blocked ? 'unblock' : 'block'}
    </button>
  )
}
