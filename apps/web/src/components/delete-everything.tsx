'use client'

import { useState } from 'react'
import { Mark } from '@/components/ledger'

/**
 * Erase everything, with one confirmation step and no modal.
 *
 * The confirmation is a second button rather than a dialog because the action
 * is irreversible but not dangerous to anyone else, and a modal for a
 * two-second decision is the interruption this world refuses. The armed state
 * names what will go, in the visitor's terms, before it goes.
 *
 * There is no signed-out state to render. A visitor who has never asked the
 * agent anything has no session and no ledger, and the endpoint answers 401 —
 * which is the same outcome as deleting nothing, so it reports done rather
 * than teaching them about session cookies.
 */
export function DeleteEverything() {
  const [armed, setArmed] = useState(false)
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'failed'>('idle')

  async function erase() {
    setState('working')
    try {
      const response = await fetch('/api/account', { method: 'DELETE' })
      // 401 means there was no session to delete, which is the end state this
      // control exists to reach. Anything else is a real failure.
      if (!response.ok && response.status !== 401) throw new Error(String(response.status))
      setState('done')
    } catch {
      setState('failed')
    }
  }

  if (state === 'done') {
    return (
      <div className="border-y border-rule py-4">
        {/*
         * Ink, not the ok tone. DESIGN.md's Nothing-Is-Green-When-It-Is-Fine
         * rule: a call that worked is ink, and the ok ink is reserved for money
         * that came back. A green word here would be the first success on the
         * site to take a colour, and it would cost the failure state below the
         * contrast that makes it leap off the page.
         */}
        <span className="text-[12px] uppercase tracking-[0.08em] text-sumi-500">deleted</span>
        <p className="mt-1 max-w-[68ch] text-[15px] leading-[1.7] text-sumi-900">
          Your ledger, your conversation and your traces are gone, and so is the anonymous account
          that held them. Opening the chat again starts you over with a fresh copy of the synthetic
          ledger.
        </p>
      </div>
    )
  }

  return (
    <div className="border-y border-rule py-4">
      {armed ? (
        <>
          <p className="max-w-[68ch] text-[15px] leading-[1.7] text-sumi-900">
            This deletes your ledger, your conversation, every trace of it, and the anonymous
            account holding them. It cannot be undone.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <button
              type="button"
              onClick={erase}
              disabled={state === 'working'}
              className="bg-sumi-900 px-6 py-2.5 text-[14px] text-paper-50 transition-colors hover:bg-sumi-800 disabled:bg-paper-200 disabled:text-sumi-500"
            >
              {state === 'working' ? 'Deleting…' : 'Delete it all'}
            </button>
            <button
              type="button"
              onClick={() => setArmed(false)}
              className="border border-sumi-900 px-6 py-2.5 text-[14px] text-sumi-900 transition-colors hover:bg-paper-200"
            >
              Keep it
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setArmed(true)}
          className="border border-sumi-900 px-6 py-2.5 text-[14px] text-sumi-900 transition-colors hover:bg-paper-200"
        >
          Delete everything now
        </button>
      )}

      {state === 'failed' ? (
        <div className="mt-4">
          <Mark tone="danger">failed</Mark>
          <p className="mt-1 max-w-[68ch] text-[14px] leading-[1.4] text-sumi-800">
            Nothing was deleted. Reload and try again; if it keeps failing, your data is still
            removed automatically within 24 hours.
          </p>
        </div>
      ) : null}
    </div>
  )
}
