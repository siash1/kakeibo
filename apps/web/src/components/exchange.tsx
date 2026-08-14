// The money subpath, not the package barrel. `money.ts` imports nothing, while
// the barrel re-exports the repositories and would pull Drizzle and pg into the
// client bundle behind the chat page.
import { formatMinor } from '@kakeibo/ledger/money'
import type { ReactNode } from 'react'
import { Mark } from '@/components/ledger'
import { cn } from '@/lib/cn'

/**
 * One exchange with the agent, in the account book's vocabulary.
 *
 * These are shared by the live page at `/chat` and by the recorded exchange the
 * landing page replays, and that sharing is load-bearing rather than tidy: the
 * landing's whole claim is "this is the thing itself, recorded". If the demo
 * drew its own bars and rules, the first thing a visitor would notice on
 * reaching `/chat` is that the demo was a picture of a different product.
 *
 * The layout is a ledger spread. The answer is prose in the book's column; every
 * tool call, token and paisa posts to a ruled margin beside it; a write stops
 * the page with a slip laid across both columns. Rules, never cards — there are
 * no cards in a 家計簿.
 */

/**
 * Compact, readable arguments for the margin.
 *
 * Money is rendered as money. `amount_minor 2000000` is both longer and less
 * informative than `amount ₹20,000.00`, and on a write it is the argument the
 * whole gate is about — so when a gloss has to be cut, the cheapest thing to
 * lose should not be the amount. Everything else stays verbatim.
 */
export function gloss(args: unknown): string {
  if (args === null || typeof args !== 'object') return String(args ?? '')
  return Object.entries(args as Record<string, unknown>)
    .map(([key, value]) => {
      const money = pairMinor(key, value)
      if (money) return `${key.replace(/(^|_)minor$|Minor$/, '') || 'amount'} ${money}`
      return `${key} ${typeof value === 'object' ? JSON.stringify(value) : value}`
    })
    .join(' · ')
}

/**
 * The agent's answers arrive as markdown and are shown as prose.
 *
 * Bold is the only span the model actually reaches for in a figure-heavy answer
 * — it emphasises the amount — and rendering it is the difference between a
 * number that reads as a number and one that reads as `**₹5,443.00**`. Nothing
 * else is interpreted: every other character stays literal text, which keeps
 * untrusted statement descriptions inert by construction rather than by
 * escaping.
 */
export function inlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: split of a fixed string
      <strong key={index} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  )
}

/** The question, set as the heading of its entry and sitting on the rule. */
export function QuestionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="mt-14 border-t border-sumi-900 pt-4 first:mt-6">
      <h2 className="max-w-[42ch] font-serif text-[clamp(1.125rem,3vw,1.375rem)] leading-[1.35] tracking-[-0.01em]">
        {children}
      </h2>
    </div>
  )
}

/** The ledger spread: prose column, margin column, and slips spanning both. */
export function Spread({ children }: { children: ReactNode }) {
  return (
    <div className="mt-5 grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_13.5rem]">
      {children}
    </div>
  )
}

export function Prose({ children }: { children: ReactNode }) {
  return (
    <p className="max-w-[68ch] whitespace-pre-wrap text-[15px] leading-[1.7] text-sumi-900">
      {children}
    </p>
  )
}

/**
 * The margin: what the agent did, and what the turn cost.
 *
 * It carries no heading of its own. A turn that suspends on a write reaches the
 * gate having completed no tool calls at all, and a margin that always printed
 * "Entries" gave that turn a column heading with one ruled line and nothing
 * under it — a label for an empty set, which reads as a bug rather than as the
 * truth it was trying to tell. Each block inside brings its own heading, so a
 * block that has nothing to say is simply absent.
 */
export function Margin({ children }: { children: ReactNode }) {
  return (
    <aside className="min-w-0 border-t border-rule pt-4 text-[12px] lg:border-t-0 lg:border-l lg:border-rule lg:pt-0 lg:pl-5">
      {children}
    </aside>
  )
}

/** A column head in the margin. */
export function MarginHeading({ children }: { children: ReactNode }) {
  return <div className="uppercase tracking-[0.11em] text-sumi-500">{children}</div>
}

/**
 * The margin shows what a tool returned, not the fence it was returned inside.
 *
 * Every tool result is wrapped in `<tool_data>` before it reaches the model —
 * that fence is the prompt-injection defence (packages/core/src/prompt.ts), and
 * it is exactly right in the transcript the model reads and in the trace viewer,
 * which exists to show the machine's own record. In a 13rem margin it spends the
 * first forty characters of a one-line preview on a constant, so the reader sees
 * the same opening on every entry and never reaches the part that differs.
 *
 * Stripped for display only. Nothing that is persisted, traced or sent anywhere
 * passes through here.
 */
function unfence(result: string): string {
  return result
    .replace(/^\s*<tool_data>\s*/i, '')
    .replace(/\s*<\/tool_data>\s*$/i, '')
    .trim()
}

/**
 * What a tool returned, in one line, or nothing at all.
 *
 * The loop sends this event's `summary` as the raw payload cut at 200
 * characters, so what reached the margin was a JSON fragment ending mid-token:
 * `{ "period": { "from": "2025-03-01", "to…`. That is the one machine artifact
 * in the book carrying no information — it repeats the gloss printed directly
 * above it and then stops before anything that differs.
 *
 * So: parse it and say what came back, or say nothing. A payload short enough
 * to survive the cut parses and yields a real count and total; one that was
 * clipped does not parse, and an empty line under the tool name is more honest
 * than a truncated one. The trace link carries the full result either way.
 *
 * Deriving the line here rather than widening the event keeps this a display
 * concern: `summary` also feeds nothing else, but the loop's 200-character cut
 * is what stops a 40kB tool result streaming to every browser.
 */
function describeResult(raw: string, isError: boolean): string {
  const text = unfence(raw)
  if (isError) return text

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return ''
  }

  const rows = (value: unknown): number | null =>
    Array.isArray(value)
      ? value.length
      : value && typeof value === 'object'
        ? (Object.values(value as Record<string, unknown>)
            .filter(Array.isArray)
            .sort((a, b) => b.length - a.length)[0]?.length ?? null)
        : null

  /** The first `formatted` string the payload carries, at most two deep. */
  const formatted = (value: unknown, depth = 0): string | null => {
    if (!value || typeof value !== 'object' || depth > 2) return null
    const record = value as Record<string, unknown>
    if (typeof record.formatted === 'string') return record.formatted
    for (const nested of Object.values(record)) {
      const found = formatted(nested, depth + 1)
      if (found) return found
    }
    return null
  }

  const count = rows(parsed)
  const parts = [
    count === null ? null : `${count} ${count === 1 ? 'row' : 'rows'}`,
    formatted(parsed),
  ].filter(Boolean)

  if (parts.length > 0) return parts.join(' · ')
  return typeof parsed === 'object' ? '' : String(parsed)
}

/**
 * Money in a tool's arguments, shown as money as well as as itself.
 *
 * Every amount crossing a tool boundary is integer minor units, and the slip
 * must show the literal call being authorised — `2000000` is what will be
 * written. But this is the one screen where a person is being asked to approve
 * a number, and making them divide by a hundred to find out it is ₹20,000 is
 * the wrong place to be terse. Both, then: the figure they recognise and the
 * argument they are actually signing.
 */
function pairMinor(key: string, value: unknown): string | null {
  if (!/(^|_)minor$|Minor$/.test(key)) return null
  return typeof value === 'number' && Number.isInteger(value) ? formatMinor(value) : null
}

/** One posted entry: the tool, what it was given, what it returned. */
export function MarginEntry({
  name,
  args,
  result,
  isError,
  isWrite,
  running,
  awaiting,
}: {
  name: string
  args?: unknown
  result?: string | undefined
  isError?: boolean
  isWrite?: boolean
  running?: boolean
  /** Proposed, and held at the gate: the turn stopped before this one ran. */
  awaiting?: boolean
}) {
  const detail = args === undefined ? '' : gloss(args)
  const summary = result ? describeResult(result, isError === true) : ''
  return (
    <li className="border-b border-rule py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[12px] text-sumi-900">{name}</span>
        {isWrite ? <Mark tone="warn">write</Mark> : null}
      </div>
      {detail ? (
        <div
          className={cn(
            'text-[11px] leading-snug text-sumi-500',
            // A write held at the gate wraps instead of truncating. Everywhere
            // else one line keeps the margin a margin, but the arguments of the
            // call a person is about to authorise are not the place to save
            // twelve pixels.
            awaiting ? 'break-words' : 'truncate',
          )}
          title={detail}
        >
          {detail}
        </div>
      ) : null}
      {summary ? (
        <div
          className={cn(
            'mt-0.5 truncate text-[11px] leading-snug',
            isError ? 'text-danger-ink' : 'text-sumi-600',
          )}
          title={summary}
        >
          {summary}
        </div>
      ) : awaiting ? (
        <div className="mt-0.5 text-[11px] leading-snug text-warn-ink">awaiting your decision</div>
      ) : running ? (
        <div className="pulse-dot mt-0.5 text-[11px] text-sumi-500">running</div>
      ) : null}
    </li>
  )
}

export function MarginEntries({
  label = 'Entries',
  children,
}: {
  label?: string
  children: ReactNode
}) {
  return (
    <>
      <MarginHeading>{label}</MarginHeading>
      <ol className="mt-2 border-t border-rule-strong">{children}</ol>
    </>
  )
}

/** What the turn cost, ruled as a column of figures. */
export function TurnAccount({
  latencyMs,
  inputTokens,
  cachedTokens,
  outputTokens,
  costUsd,
  evictions = 0,
  runId,
}: {
  latencyMs: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  costUsd: number
  evictions?: number
  runId?: string
}) {
  const cachedPercent = inputTokens > 0 ? Math.round((cachedTokens / inputTokens) * 100) : 0

  return (
    <dl className="mt-4 border-t border-sumi-900 pt-2">
      <AccountLine label="elapsed" value={`${(latencyMs / 1000).toFixed(1)}s`} />
      <AccountLine
        label="in"
        value={inputTokens.toLocaleString()}
        note={`${cachedPercent}% cached`}
      />
      <AccountLine label="out" value={outputTokens.toLocaleString()} />
      <AccountLine label="cost" value={`$${costUsd.toFixed(6)}`} />
      {evictions > 0 ? (
        <AccountLine label="evictions" value={String(evictions)} tone="warn" />
      ) : null}
      {runId ? (
        <div className="mt-2.5">
          <a href={`/runs/${runId}`} className="text-[12px] text-sumi-800 hover:text-sumi-900">
            Read the trace →
          </a>
        </div>
      ) : null}
    </dl>
  )
}

export function AccountLine({
  label,
  value,
  note,
  tone = 'ink',
}: {
  label: string
  value: string
  note?: string
  tone?: 'ink' | 'warn'
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <dt className="text-[11px] uppercase tracking-[0.09em] text-sumi-500">{label}</dt>
      <dd
        className={cn(
          'num text-right text-[12px]',
          tone === 'warn' ? 'text-warn-ink' : 'text-sumi-900',
        )}
      >
        {value}
        {note ? <span className="ml-1.5 text-[11px] text-sumi-500">{note}</span> : null}
      </dd>
    </div>
  )
}

/**
 * The write gate, as a slip laid across the page.
 *
 * It spans both columns and rules off top and bottom because the turn has
 * genuinely stopped: the loop is suspended in the database waiting on this
 * answer. A card tucked in the margin would read as a log line about something
 * that already happened, which is the opposite of what it is.
 */
export function ConfirmSlip({
  writes,
  state,
  onAllow,
  onDecline,
}: {
  /** Every write of one suspended turn. They are answered together or not at all. */
  writes: { id: string; tool: string; summary: string; args: unknown }[]
  state: 'pending' | 'sending' | 'allowed' | 'declined' | 'expired'
  onAllow?: () => void
  onDecline?: () => void
}) {
  if (writes.length === 0) return null
  const many = writes.length > 1

  return (
    <section className="mt-4 border-y-2 border-sumi-900 py-5 lg:col-span-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-serif text-[17px] font-semibold tracking-[-0.01em]">
          {many
            ? `These ${writes.length} writes will change your ledger`
            : 'This will change your ledger'}
        </h3>
        <span className="text-[12px] uppercase tracking-[0.09em] text-sumi-600">
          {many ? `${writes.length} writes` : writes[0]?.tool}
        </span>
      </div>

      {/*
        One decision covers the batch, so every write in it has to be readable
        before the visitor answers: the loop suspends on all of them together
        and there is no way to allow one and hold the rest.
      */}
      {writes.map((write) => (
        <WriteProposal key={write.id} write={write} labelled={many} />
      ))}

      {state === 'pending' ? (
        <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            type="button"
            onClick={onAllow}
            className="bg-sumi-900 px-5 py-2 text-[13px] text-paper-50 transition-colors hover:bg-sumi-800"
          >
            {many ? 'Allow all' : 'Allow'}
          </button>
          <button
            type="button"
            onClick={onDecline}
            className="border border-sumi-900 px-5 py-2 text-[13px] text-sumi-900 transition-colors hover:bg-paper-200"
          >
            {many ? 'Decline all' : 'Decline'}
          </button>
          <span className="text-[12px] text-sumi-500">The turn is paused until you decide.</span>
        </div>
      ) : (
        <p className="mt-4 text-[13px] text-sumi-600">
          {state === 'sending'
            ? 'Sending your decision…'
            : state === 'allowed'
              ? 'Allowed. The turn resumed.'
              : state === 'declined'
                ? 'Declined. Nothing was written.'
                : 'This confirmation expired before it was answered. Nothing was written. Ask again to start a fresh turn.'}
        </p>
      )}
    </section>
  )
}

/** One proposed write inside the slip: what it is, and its literal arguments. */
function WriteProposal({
  write,
  labelled,
}: {
  write: { tool: string; summary: string; args: unknown }
  labelled: boolean
}) {
  const fields =
    write.args && typeof write.args === 'object' ? (write.args as Record<string, unknown>) : {}

  return (
    <div className={labelled ? 'mt-5 border-t border-rule-strong pt-4 first-of-type:mt-4' : ''}>
      {labelled ? (
        <span className="text-[12px] uppercase tracking-[0.09em] text-sumi-600">{write.tool}</span>
      ) : null}

      <p className="mt-2 max-w-[62ch] text-[15px] leading-relaxed text-sumi-900">{write.summary}</p>

      {Object.keys(fields).length > 0 ? (
        <dl className="mt-4 max-w-[42rem] border-t border-rule">
          {Object.entries(fields).map(([key, value]) => {
            const asMoney = pairMinor(key, value)
            return (
              <div
                key={key}
                className="grid grid-cols-[8rem_minmax(0,1fr)] items-baseline gap-4 border-b border-rule py-1.5 sm:grid-cols-[10rem_minmax(0,1fr)]"
              >
                <dt className="text-[12px] uppercase tracking-[0.08em] text-sumi-500">{key}</dt>
                <dd className="num min-w-0 break-words text-[13px] text-sumi-900">
                  {asMoney ? (
                    <>
                      {asMoney}
                      <span className="ml-2 text-[12px] text-sumi-500">
                        {String(value)} minor units
                      </span>
                    </>
                  ) : typeof value === 'object' ? (
                    JSON.stringify(value)
                  ) : (
                    String(value)
                  )}
                </dd>
              </div>
            )
          })}
        </dl>
      ) : null}
    </div>
  )
}
