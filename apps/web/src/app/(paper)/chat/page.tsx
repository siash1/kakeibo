'use client'

import { useCallback, useRef, useState } from 'react'
import {
  ConfirmSlip,
  inlineMarkdown,
  Margin,
  MarginEntries,
  MarginEntry,
  Prose,
  QuestionHeading,
  Spread,
  TurnAccount,
} from '@/components/exchange'
import { Mark } from '@/components/ledger'
import { mayAsk, TurnstileGate, turnstileSiteKey } from '@/components/turnstile-gate'
import { type ConfirmGroup, decisionsFor, groupBySuspendedTurn } from '@/lib/confirm'

/**
 * /chat — the agent, as a page of the account book.
 *
 * THESIS: a conversation is a set of entries posted against a narrative, so the
 * answer reads as prose in the book's column and every tool call, token and
 * paisa the agent spent getting there posts to the margin beside it. It refuses
 * the chat-bubble transcript: bubbles make the machinery either noise between
 * speech acts or something you have to open a drawer to see, and the machinery
 * is what this visitor came to evaluate.
 *
 * OWN-WORLD: the committed paper genre — warm paper, sumi ink, ruled hairlines,
 * no chromatic accent. Rules, never cards. The question is a heading sitting on
 * its rule; the margin is a ruled column of entries; the composer is the blank
 * writing line at the foot of the page.
 *
 * STORY: the visitor asks something real in one click, watches the entries post
 * one by one while the answer is still being written, reads what it cost, and
 * can open the full trace. Asking for a write stops the book mid-page and asks
 * for a signature.
 *
 * FIRST VIEWPORT: a serif question-list ruled into the page under one line of
 * honest provenance; the writing line pinned at the foot. No hero, no card
 * grid — the page opens as an index of questions the book can answer.
 *
 * FORM: ruled ledger spread with a marginal record, pinned by the owner in the
 * Phase 2 direction round (machinery = a ledger margin rail, empty state = a
 * ruled question list), which outranks the roll.
 *
 * FINISH: unreviewed and undocumented is unfinished; this build ends with the
 * finish review, the verdict, and DESIGN.md.
 */

interface ToolEvent {
  kind: 'tool'
  id: string
  name: string
  args: unknown
  tier: string
  result?: string
  isError?: boolean
}

interface ConfirmEvent {
  kind: 'confirm'
  id: string
  tool: string
  summary: string
  args: unknown
  /** Which paused turn this card belongs to; answering resumes exactly that one. */
  suspendedTurnId: string
  /**
   * Undefined until the visitor answers. `sending` is the window in which the
   * decision is in flight and nothing is yet true of the ledger: the slip used
   * to skip it and assert the outcome before the request was made, so a resume
   * refused for a pause or the daily cap left the page claiming a write had
   * been allowed when the server had not even read the suspended row.
   */
  status?: 'sending' | 'allowed' | 'declined' | 'expired'
}

interface TextEvent {
  kind: 'text'
  text: string
}

/**
 * Something the page has to say on its own behalf — an error, an expiry.
 *
 * Kept as its own kind rather than appended to the prose: an error rendered as
 * the agent's own words reads as the model saying it, which is both untrue and
 * the one place a finance tool cannot afford ambiguity about who is speaking.
 */
interface NoteEvent {
  kind: 'note'
  tone: 'warn' | 'danger'
  text: string
}

type Item = TextEvent | ToolEvent | ConfirmEvent | NoteEvent

interface Message {
  role: 'user' | 'assistant'
  items: Item[]
  usage?: {
    run_id: string
    latency_ms: number
    cost_usd_est: number
    usage: { inputTokens: number; outputTokens: number; cachedTokens: number }
    iterations: number
    status: string
    evictions: number
  }
}

/**
 * The opening index.
 *
 * `label` names what part of the book the question opens — a description of the
 * question itself, never a prediction of which tools the agent will pick. The
 * last one writes, and says so: one click is the shortest path to the
 * confirm-before-write gate, which is the most distinctive thing here.
 */
const SUGGESTIONS: { text: string; label: string; writes?: boolean }[] = [
  { text: 'What did I spend on groceries in March 2025?', label: 'spending' },
  { text: 'What subscriptions am I paying for?', label: 'recurring' },
  { text: 'Anything unusual in April 2025?', label: 'anomalies' },
  { text: 'Compare groceries and dining across March and April.', label: 'comparison' },
  { text: 'Set a ₹20,000 monthly budget for Groceries.', label: 'budget', writes: true },
]

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [limited, setLimited] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /**
   * Chosen by the server on the first turn and echoed back on every one after,
   * so a reload picks the thread up rather than starting a second.
   */
  const conversationId = useRef<string | undefined>(undefined)
  /**
   * The newest Turnstile token, and the counter that replaces it.
   *
   * A token is single-use, so it is cleared the moment a turn has spent it and
   * the widget is asked for another. `ready` is what the composer waits on:
   * with no site key configured there is no gate and nothing to wait for, which
   * is the local and CI state.
   */
  const turnstileToken = useRef<string | undefined>(undefined)
  const [turnstileGeneration, setTurnstileGeneration] = useState(0)
  const [verified, setVerified] = useState(mayAsk(turnstileSiteKey, undefined))

  const holdToken = useCallback((token: string | undefined) => {
    turnstileToken.current = token
    setVerified(mayAsk(turnstileSiteKey, token))
  }, [])

  /**
   * Follows the stream only while the reader is already at the foot of the page.
   *
   * The page scrolls, rather than a pane inside it, so an unconditional
   * scrollIntoView on every token would drag the reader back down mid-sentence
   * every time they scrolled up to re-read an entry.
   */
  const follow = useCallback((smooth: boolean) => {
    if (typeof window === 'undefined') return
    const distance = document.body.scrollHeight - (window.scrollY + window.innerHeight)
    if (distance > 220) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    endRef.current?.scrollIntoView({ behavior: smooth && !reduced ? 'smooth' : 'auto' })
  }, [])

  const patchLast = useCallback((fn: (message: Message) => Message) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev
      const next = [...prev]
      next[next.length - 1] = fn(next[next.length - 1]!)
      return next
    })
  }, [])

  const note = useCallback(
    (tone: NoteEvent['tone'], text: string) => {
      patchLast((message) => ({
        ...message,
        items: [...message.items, { kind: 'note', tone, text }],
      }))
    },
    [patchLast],
  )

  /**
   * Reads one SSE response into the last assistant message.
   *
   * Both /api/chat and /api/confirm return the same event stream, because they
   * are two halves of one turn — the second picks up where the first suspended.
   */
  const consume = useCallback(
    async (response: Response): Promise<'resumed' | 'refused' | 'expired'> => {
      if (response.status === 503) {
        const body = (await response.json()) as { error?: string }
        setLimited(body.error ?? 'Live chat is unavailable right now.')
        return 'refused'
      }
      if (response.status === 410) {
        note('warn', 'That confirmation had already expired. Ask again to start a fresh turn.')
        return 'expired'
      }
      if (response.status === 403) {
        // The gate, not the ledger: this is the one refusal that has nothing to
        // do with what was asked.
        setLimited('Verification failed. Reload the page and try again.')
        return 'refused'
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `HTTP ${response.status}`)
      }
      if (!response.body) throw new Error('no response body')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE frames are separated by a blank line.
        for (;;) {
          const split = buffer.indexOf('\n\n')
          if (split < 0) break
          const frame = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          const eventLine = frame.split('\n').find((l) => l.startsWith('event: '))
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
          if (!eventLine || !dataLine) continue
          handleEvent(eventLine.slice(7), JSON.parse(dataLine.slice(6)))
        }
      }

      // The stream ran to completion, so the server took the decision and the
      // turn genuinely resumed. Only this answer entitles the slip to say so.
      return 'resumed'

      function handleEvent(event: string, data: Record<string, unknown>) {
        if (event === 'token') {
          patchLast((message) => {
            const items = [...message.items]
            const last = items[items.length - 1]
            if (last?.kind === 'text') {
              items[items.length - 1] = { kind: 'text', text: last.text + String(data.delta) }
            } else {
              items.push({ kind: 'text', text: String(data.delta) })
            }
            return { ...message, items }
          })
          follow(false)
          return
        }

        if (event === 'tool_call') {
          patchLast((message) => ({
            ...message,
            items: [
              ...message.items,
              {
                kind: 'tool',
                id: String(data.id),
                name: String(data.name),
                args: data.args,
                tier: String(data.tier),
              },
            ],
          }))
        } else if (event === 'tool_result') {
          patchLast((message) => ({
            ...message,
            items: message.items.map((item) =>
              item.kind === 'tool' && item.id === data.id
                ? { ...item, result: String(data.summary), isError: Boolean(data.isError) }
                : item,
            ),
          }))
        } else if (event === 'confirm_request') {
          patchLast((message) => ({
            ...message,
            items: [
              ...message.items,
              {
                kind: 'confirm',
                id: String(data.id),
                tool: String(data.tool),
                summary: String(data.summary),
                args: data.args,
                suspendedTurnId: String(data.suspended_turn_id),
              },
            ],
          }))
        } else if (event === 'turn_end') {
          if (data.conversation_id) conversationId.current = String(data.conversation_id)
          patchLast((message) => ({ ...message, usage: data as unknown as Message['usage'] }))
        } else if (event === 'error') {
          note('danger', String(data.message))
        }
        follow(true)
      }
    },
    [follow, note, patchLast],
  )

  /**
   * Answers a confirmation, which resumes the paused turn.
   *
   * The rest of the turn streams back on *this* response. Nothing is waiting on
   * the original request — it ended when the turn suspended.
   */
  const answer = useCallback(
    async (group: ConfirmGroup<ConfirmEvent>, allow: boolean) => {
      if (busy) return
      setBusy(true)

      const ids = new Set(group.writes.map((write) => write.id))
      const setStatus = (status: ConfirmEvent['status']) =>
        patchLast((message) => ({
          ...message,
          items: message.items.map((existing) =>
            existing.kind === 'confirm' && ids.has(existing.id)
              ? { ...existing, status }
              : existing,
          ),
        }))

      // In flight, which is not an outcome. The slip says so rather than
      // announcing a write that the server has not agreed to yet.
      setStatus('sending')

      try {
        const outcome = await consume(
          await fetch('/api/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              suspendedTurnId: group.suspendedTurnId,
              // Every write of the batch, because runTurn declines by omission
              // and the loop cannot answer a batch piecemeal.
              decisions: decisionsFor(group.writes, allow),
            }),
          }),
        )

        if (outcome === 'resumed') setStatus(allow ? 'allowed' : 'declined')
        // Refused: the suspended turn is untouched and still answerable once
        // the pause lifts or the cap resets, so the slip goes back to pending
        // rather than stranding the visitor with no control.
        else if (outcome === 'refused') setStatus(undefined)
        else setStatus('expired')
      } catch (error) {
        note('danger', error instanceof Error ? error.message : String(error))
        setStatus(undefined)
      } finally {
        setBusy(false)
        follow(true)
      }
    },
    [busy, consume, follow, note, patchLast],
  )

  const send = useCallback(
    async (text: string) => {
      // `verified` guards here as well as on the button, because the opening
      // question list calls this directly and a turn sent without a token would
      // come back 403 for a reason the visitor cannot see.
      if (!text.trim() || busy || !verified) return
      setBusy(true)
      setLimited(null)
      setInput('')
      setMessages((prev) => [
        ...prev,
        { role: 'user', items: [{ kind: 'text', text }] },
        { role: 'assistant', items: [] },
      ])

      try {
        await consume(
          await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: text,
              conversationId: conversationId.current,
              turnstileToken: turnstileToken.current,
            }),
          }),
        )
      } catch (error) {
        note('danger', error instanceof Error ? error.message : String(error))
      } finally {
        // Spent, whatever happened: Cloudflare rejects a replayed token, so the
        // held one is dropped and the widget asked for another.
        holdToken(undefined)
        setTurnstileGeneration((generation) => generation + 1)
        setBusy(false)
        follow(true)
        inputRef.current?.focus()
      }
    },
    [busy, consume, follow, holdToken, note, verified],
  )

  return (
    <div className="flex min-h-[calc(100vh-11rem)] flex-col">
      {/*
       * The composer is sticky and opaque, so the transcript needs a foot of
       * clear paper under it. Without this the last thing on the page — which
       * during a write is the confirmation slip, the one thing on this site a
       * person must read before deciding — sits permanently under the writing
       * line with no way to scroll it clear.
       */}
      <div className="flex-1 pb-24">
        {messages.length === 0 ? <Opening onPick={send} ready={verified} /> : null}

        {messages.map((message, index) =>
          message.role === 'user' ? (
            <QuestionHeading
              // biome-ignore lint/suspicious/noArrayIndexKey: messages are append-only
              key={index}
            >
              {message.items.map((item) => (item.kind === 'text' ? item.text : '')).join('')}
            </QuestionHeading>
          ) : (
            <Entry
              // biome-ignore lint/suspicious/noArrayIndexKey: messages are append-only
              key={index}
              message={message}
              pending={busy && index === messages.length - 1}
              onAnswer={answer}
            />
          ),
        )}

        {limited ? (
          <div className="mt-10 border-y border-sumi-900 py-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Mark tone="warn">paused</Mark>
              <p className="text-[13px] text-sumi-800">{limited}</p>
            </div>
          </div>
        ) : null}

        <div ref={endRef} className="h-px scroll-mb-40" />
      </div>

      <Composer
        ref={inputRef}
        value={input}
        busy={busy}
        verified={verified}
        onChange={setInput}
        onSubmit={() => send(input)}
      >
        <TurnstileGate onToken={holdToken} refreshKey={turnstileGeneration} />
      </Composer>
    </div>
  )
}

/** The index the page opens on: what the book can be asked, ruled into it. */
function Opening({ onPick, ready }: { onPick: (text: string) => void; ready: boolean }) {
  return (
    <div className="pt-4">
      <h1 className="max-w-[16ch] font-serif text-[clamp(2rem,6vw,2.75rem)] leading-[1.08] tracking-[-0.025em]">
        Ask the ledger.
      </h1>
      <p className="mt-5 max-w-[62ch] text-[15px] leading-[1.65] text-sumi-600">
        352 synthetic transactions, January to June 2025. Generated, not anyone's real spending.
        Every answer is worked out live: the agent chooses its own tools, and each one it calls is
        posted in the margin beside the answer.
      </p>

      <div className="mt-12 border-t border-sumi-900">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion.text}
            type="button"
            onClick={() => onPick(suggestion.text)}
            // Inert only while a configured Turnstile gate is still working,
            // which with an interaction-only widget is normally over before the
            // list has been read. It carries no disabled styling for that
            // reason: a list that greys itself out for half a second on load
            // reads as broken.
            disabled={!ready}
            className="group flex w-full items-baseline justify-between gap-6 border-b border-rule py-4 text-left transition-colors hover:border-sumi-900"
          >
            <span className="font-serif text-[clamp(1rem,2.6vw,1.1875rem)] leading-snug text-sumi-900">
              {suggestion.text}
            </span>
            <span className="flex shrink-0 items-baseline gap-2">
              {suggestion.writes ? <Mark tone="warn">write</Mark> : null}
              <span className="text-[12px] uppercase tracking-[0.09em] text-sumi-500 transition-colors group-hover:text-sumi-900">
                {suggestion.label}
              </span>
            </span>
          </button>
        ))}
      </div>

      <p className="mt-5 max-w-[62ch] text-[13px] leading-relaxed text-sumi-500">
        The last one writes. Anything that changes the ledger stops the turn and asks you first. The
        gate is in the loop, not in the prompt.
      </p>
    </div>
  )
}

/**
 * One answered turn: the prose in the book's column, the machinery in the
 * margin, and any confirmation spanning both because the turn has stopped.
 */
function Entry({
  message,
  pending,
  onAnswer,
}: {
  message: Message
  pending: boolean
  onAnswer: (group: ConfirmGroup<ConfirmEvent>, allow: boolean) => void
}) {
  const prose = message.items.filter((item): item is TextEvent => item.kind === 'text')
  const tools = message.items.filter((item): item is ToolEvent => item.kind === 'tool')
  const notes = message.items.filter((item): item is NoteEvent => item.kind === 'note')
  const confirms = message.items.filter((item): item is ConfirmEvent => item.kind === 'confirm')
  const quiet = prose.length === 0 && notes.length === 0
  const usage = message.usage
  /**
   * A turn held at the gate has produced no prose and completed no tool calls,
   * so without this both columns render empty beside a lone meter — on the one
   * screen whose whole job is to say the machinery stopped. The proposed write
   * posts as an entry and the book's column says why it is blank.
   */
  const held = confirms.filter((item) => item.status === undefined || item.status === 'sending')

  return (
    <Spread>
      <div className="min-w-0 space-y-4">
        {prose.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only
          <Prose key={index}>{inlineMarkdown(item.text)}</Prose>
        ))}

        {notes.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only
          <div key={index} className="max-w-[68ch] border-y border-rule py-3">
            <Mark tone={item.tone}>{item.tone === 'danger' ? 'failed' : 'note'}</Mark>
            <p className="mt-1 text-[14px] leading-relaxed text-sumi-800">{item.text}</p>
          </div>
        ))}

        {quiet && pending ? <p className="pulse-dot text-[14px] text-sumi-500">Working…</p> : null}

        {quiet && !pending && held.length > 0 ? (
          <p className="max-w-[68ch] text-[15px] leading-[1.7] text-sumi-600">
            The turn stopped here. {held.length === 1 ? 'A write is' : `${held.length} writes are`}{' '}
            waiting on you below. Nothing has been written yet, and the rest of the answer arrives
            once you decide.
          </p>
        ) : null}
      </div>

      {tools.length > 0 || held.length > 0 || usage || pending ? (
        <Margin>
          {tools.length > 0 || held.length > 0 || pending ? (
            <MarginEntries>
              {tools.map((tool) => (
                <MarginEntry
                  key={tool.id}
                  name={tool.name}
                  args={tool.args}
                  result={tool.result}
                  isError={tool.isError}
                  isWrite={tool.tier === 'write'}
                  // A write whose turn has suspended is not running, it is
                  // waiting on the slip below; only a live turn says "running".
                  running={pending}
                />
              ))}
              {held.map((item) => (
                <MarginEntry key={item.id} name={item.tool} args={item.args} isWrite awaiting />
              ))}
              {tools.length === 0 && held.length === 0 && pending ? (
                <li className="pulse-dot border-b border-rule py-2 text-[11px] text-sumi-500">
                  no entries yet
                </li>
              ) : null}
            </MarginEntries>
          ) : null}
          {usage ? (
            <TurnAccount
              latencyMs={usage.latency_ms}
              inputTokens={usage.usage.inputTokens}
              cachedTokens={usage.usage.cachedTokens}
              outputTokens={usage.usage.outputTokens}
              costUsd={usage.cost_usd_est}
              evictions={usage.evictions}
              runId={usage.run_id}
            />
          ) : null}
        </Margin>
      ) : null}

      {groupBySuspendedTurn(confirms).map((group) => (
        <ConfirmSlip
          key={group.suspendedTurnId}
          writes={group.writes}
          // The batch is decided together, so its writes always share a status;
          // the first is as good an answer as any.
          state={group.writes[0]?.status ?? 'pending'}
          onAllow={() => onAnswer(group, true)}
          onDecline={() => onAnswer(group, false)}
        />
      ))}
    </Spread>
  )
}

/**
 * The blank line at the foot of the page.
 *
 * A ruled writing line rather than a boxed field — the account book's own
 * affordance. The rule carries the focus state (rule-strong to sumi) so the
 * keyboard indicator is part of the design rather than a browser outline drawn
 * around a borderless input.
 */
function Composer({
  ref,
  value,
  busy,
  verified,
  onChange,
  onSubmit,
  children,
}: {
  ref: React.RefObject<HTMLInputElement | null>
  value: string
  busy: boolean
  /**
   * False only while a configured Turnstile gate has not yet issued a token.
   * With no gate it is true from the first render, so nothing on this page
   * behaves differently locally or in CI.
   */
  verified: boolean
  onChange: (value: string) => void
  onSubmit: () => void
  /** The Turnstile widget, which occupies no space unless it wants a click. */
  children?: React.ReactNode
}) {
  return (
    <div className="sticky bottom-0 -mx-6 mt-16 bg-paper-50 px-6 pb-6 pt-4">
      {children}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
        className="flex items-center gap-4 border-b-2 border-rule-strong pb-2 transition-colors focus-within:border-sumi-900"
      >
        <label htmlFor="ask" className="sr-only">
          Ask about your ledger
        </label>
        <input
          id="ask"
          ref={ref}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Ask about your ledger…"
          disabled={busy}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent py-1 font-serif text-[clamp(1rem,2.4vw,1.125rem)] text-sumi-900 placeholder:text-sumi-500 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || !verified || !value.trim()}
          // Disabled is a light fill with dark text rather than a dimmed dark
          // fill: paper-50 on rule-strong measures 3.4:1, which is a label you
          // have to lean in to read on the one control the page is about.
          className="shrink-0 bg-sumi-900 px-5 py-2 text-[13px] text-paper-50 transition-colors hover:bg-sumi-800 disabled:bg-paper-200 disabled:text-sumi-500"
        >
          {busy ? 'Working…' : 'Ask'}
        </button>
      </form>
    </div>
  )
}
