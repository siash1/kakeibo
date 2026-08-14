'use client'

import Script from 'next/script'
import { useCallback, useEffect, useRef } from 'react'

/**
 * The Turnstile widget, or nothing at all.
 *
 * Renders nothing when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is absent, which is the
 * local and CI state — `verifyTurnstile` is inert on exactly the same
 * condition, so the two halves cannot disagree about whether the gate is on.
 *
 * `interaction-only` appearance, so the widget occupies no space and shows
 * nothing at all unless Cloudflare actually wants a click. The one place it can
 * appear is directly above the writing line, because a challenge the visitor
 * cannot see is a page that has simply stopped working.
 *
 * **A token is single-use.** Cloudflare rejects a replayed one as
 * `timeout-or-duplicate`, so a widget mounted on the opening screen and
 * unmounted after the first question would gate turn one and 403 every turn
 * after it. That is why this lives beside the composer for the life of the page
 * and why `refreshKey` exists: the chat page increments it after each turn and
 * the widget mints a fresh token for the next one.
 */

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, options: Record<string, unknown>) => string
      reset: (id?: string) => void
    }
  }
}

/**
 * Read at module scope because Next inlines `NEXT_PUBLIC_*` at build time.
 * Exported so the chat page can ask the same question the widget asks — whether
 * there is a gate to wait for — without duplicating the variable name.
 */
export const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? ''

/**
 * Whether a turn may be sent yet.
 *
 * With a site key, a turn needs a fresh single-use token and the composer waits
 * for one between turns. With no site key there is no widget, no callback and
 * therefore no token that will ever arrive, so the only correct answer is yes.
 *
 * It takes the key as an argument rather than reading the module constant so a
 * test can ask both questions; it exists as a function at all because asking it
 * in one place and forgetting it in another is not a hypothetical. The composer
 * seeded its state with the unconfigured case and then cleared that same state
 * after every turn without it, which gated the second question of every session
 * on a token that could not exist — live, on a site whose Turnstile keys are
 * deliberately empty, from 2026-08-10 until it was found by asking a second
 * question. Both call sites now ask this.
 */
export function mayAsk(siteKey: string, token: string | undefined): boolean {
  return siteKey === '' || token !== undefined
}

export function TurnstileGate({
  onToken,
  refreshKey = 0,
}: {
  /** A fresh token, or undefined when the one held is no longer usable. */
  onToken: (token: string | undefined) => void
  /** Increment to discard the current token and mint another. */
  refreshKey?: number
}) {
  const holder = useRef<HTMLDivElement>(null)
  const widget = useRef<string | undefined>(undefined)

  const render = useCallback(() => {
    if (!turnstileSiteKey || !window.turnstile || !holder.current || widget.current) return
    widget.current = window.turnstile.render(holder.current, {
      sitekey: turnstileSiteKey,
      appearance: 'interaction-only',
      callback: (token: string) => onToken(token),
      // Both of these leave the page with no usable token, so the held one is
      // dropped rather than sent and rejected.
      'error-callback': () => {
        onToken(undefined)
        window.turnstile?.reset(widget.current)
      },
      'expired-callback': () => {
        onToken(undefined)
        window.turnstile?.reset(widget.current)
      },
    })
  }, [onToken])

  // The script may already be on the page — a client-side navigation back to
  // /chat does not reload it — in which case next/script's onReady still fires,
  // but rendering here too costs nothing and removes the ordering question.
  useEffect(render, [render])

  useEffect(() => {
    if (refreshKey === 0 || !widget.current) return
    window.turnstile?.reset(widget.current)
  }, [refreshKey])

  if (!turnstileSiteKey) return null

  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js"
        strategy="afterInteractive"
        onReady={render}
      />
      <div ref={holder} className="empty:hidden" />
    </>
  )
}
