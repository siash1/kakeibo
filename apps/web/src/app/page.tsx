'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Card } from '@/components/ui'
import { cn } from '@/lib/cn'

/**
 * The chat page (spec 13).
 *
 * Tool calls and confirmation cards are first-class UI, not a debug dump: the
 * whole point of the confirm-before-write tier is that a human reads what is
 * about to change and decides, and a card that looks like console output does
 * not get read.
 */

interface ToolEvent {
  kind: 'tool'
  id: string
  name: string
  args: unknown
  tier: string
  result?: string
  isError?: boolean
  confirmed?: boolean
}

interface ConfirmEvent {
  kind: 'confirm'
  id: string
  tool: string
  summary: string
  args: unknown
  answered?: boolean
  allowed?: boolean
}

interface TextEvent {
  kind: 'text'
  text: string
}

type Item = TextEvent | ToolEvent | ConfirmEvent

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

const SUGGESTIONS = [
  'What did I spend on groceries in March 2025?',
  'What subscriptions am I paying for?',
  'Anything unusual in April 2025?',
  'Compare groceries and dining across March and April.',
]

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const sessionId = useRef<string>('web-session')

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const patchLast = useCallback((fn: (message: Message) => Message) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev
      const next = [...prev]
      next[next.length - 1] = fn(next[next.length - 1]!)
      return next
    })
  }, [])

  const answer = useCallback(
    async (id: string, allow: boolean) => {
      await fetch('/api/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, allow }),
      })
      patchLast((message) => ({
        ...message,
        items: message.items.map((item) =>
          item.kind === 'confirm' && item.id === id
            ? { ...item, answered: true, allowed: allow }
            : item,
        ),
      }))
    },
    [patchLast],
  )

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || busy) return
      setBusy(true)
      setInput('')
      setMessages((prev) => [
        ...prev,
        { role: 'user', items: [{ kind: 'text', text }] },
        { role: 'assistant', items: [] },
      ])

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, sessionId: sessionId.current }),
        })
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
      } catch (error) {
        patchLast((message) => ({
          ...message,
          items: [
            ...message.items,
            { kind: 'text', text: `\n\nError: ${error instanceof Error ? error.message : error}` },
          ],
        }))
      } finally {
        setBusy(false)
        endRef.current?.scrollIntoView({ behavior: 'smooth' })
      }

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
        } else if (event === 'tool_call') {
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
              },
            ],
          }))
        } else if (event === 'turn_end') {
          patchLast((message) => ({ ...message, usage: data as unknown as Message['usage'] }))
        } else if (event === 'error') {
          patchLast((message) => ({
            ...message,
            items: [...message.items, { kind: 'text', text: `\n\nError: ${String(data.message)}` }],
          }))
        }
        endRef.current?.scrollIntoView({ behavior: 'smooth' })
      }
    },
    [busy, patchLast],
  )

  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col">
      <div className="flex-1 space-y-5 overflow-y-auto pb-4">
        {messages.length === 0 ? (
          <div className="pt-16 text-center">
            <p className="text-sm text-ink-300">Ask about your ledger.</p>
            <p className="mt-1 text-xs text-ink-500">
              352 seeded transactions, January to June 2025.
            </p>
            <div className="mx-auto mt-6 flex max-w-xl flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => send(suggestion)}
                  className="rounded-full border border-ink-800 px-3 py-1.5 text-xs text-ink-300 transition-colors hover:border-accent-dim hover:text-accent"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: messages are append-only
          <div key={index} className={cn(message.role === 'user' && 'flex justify-end')}>
            {message.role === 'user' ? (
              <div className="max-w-[80%] rounded-lg rounded-br-sm bg-ink-850 px-3.5 py-2 text-sm text-ink-100">
                {message.items.map((item, i) =>
                  // biome-ignore lint/suspicious/noArrayIndexKey: static
                  item.kind === 'text' ? <span key={i}>{item.text}</span> : null,
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {message.items.map((item, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: append-only
                  <ItemView key={i} item={item} onAnswer={answer} />
                ))}
                {message.usage ? <TurnFooter usage={message.usage} /> : null}
                {busy && index === messages.length - 1 && message.items.length === 0 ? (
                  <span className="pulse-dot inline-block text-sm text-ink-500">thinking…</span>
                ) : null}
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          send(input)
        }}
        className="flex gap-2 border-t border-ink-800 pt-4"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="What did I spend on groceries in March?"
          disabled={busy}
          className="flex-1 rounded-md border border-ink-800 bg-ink-900 px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent-dim focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-md border border-accent-dim bg-accent/10 px-4 py-2.5 font-mono text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
        >
          send
        </button>
      </form>
    </div>
  )
}

function ItemView({
  item,
  onAnswer,
}: {
  item: Item
  onAnswer: (id: string, allow: boolean) => void
}) {
  if (item.kind === 'text') {
    return (
      <div className="whitespace-pre-wrap text-sm leading-relaxed text-ink-100">{item.text}</div>
    )
  }

  if (item.kind === 'tool') {
    return (
      <Card className="px-3 py-2">
        <div className="flex items-center gap-2">
          <Badge tone={item.tier === 'write' ? 'warn' : 'accent'}>
            {item.tier === 'write' ? '✎' : '→'} {item.name}
          </Badge>
          <code className="truncate font-mono text-[11px] text-ink-500">
            {JSON.stringify(item.args)}
          </code>
        </div>
        {item.result ? (
          <div
            className={cn(
              'mt-1.5 truncate font-mono text-[11px]',
              item.isError ? 'text-danger' : 'text-ink-500',
            )}
          >
            {item.isError ? '✗ ' : '✓ '}
            {item.result}
          </div>
        ) : null}
      </Card>
    )
  }

  return (
    <Card className="border-warn/40 bg-warn/5 px-4 py-3">
      <div className="flex items-center gap-2">
        <Badge tone="warn">confirm</Badge>
        <span className="font-mono text-[11px] text-ink-500">{item.tool}</span>
      </div>
      <p className="mt-2 text-sm text-ink-100">{item.summary}</p>
      {item.answered ? (
        <p className="mt-2 font-mono text-xs text-ink-500">
          {item.allowed ? '✓ allowed' : '✗ declined'}
        </p>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => onAnswer(item.id, true)}
            className="rounded border border-ok/40 px-3 py-1 font-mono text-xs text-ok transition-colors hover:bg-ok/10"
          >
            allow
          </button>
          <button
            type="button"
            onClick={() => onAnswer(item.id, false)}
            className="rounded border border-ink-700 px-3 py-1 font-mono text-xs text-ink-300 transition-colors hover:bg-ink-850"
          >
            decline
          </button>
        </div>
      )}
    </Card>
  )
}

function TurnFooter({ usage }: { usage: NonNullable<Message['usage']> }) {
  const cachedPercent =
    usage.usage.inputTokens > 0
      ? Math.round((usage.usage.cachedTokens / usage.usage.inputTokens) * 100)
      : 0
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 font-mono text-[11px] text-ink-500">
      <span>{(usage.latency_ms / 1000).toFixed(1)}s</span>
      <span>
        {usage.usage.inputTokens} in ({cachedPercent}% cached)
      </span>
      <span>{usage.usage.outputTokens} out</span>
      <span>${usage.cost_usd_est.toFixed(6)}</span>
      {usage.evictions > 0 ? <span className="text-warn">{usage.evictions} eviction</span> : null}
      <a href={`/runs/${usage.run_id}`} className="text-accent-dim hover:text-accent">
        trace →
      </a>
    </div>
  )
}
