import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * The paper genre's primitives.
 *
 * Deliberately not the terminal `Card`/`Badge` set. That world builds from
 * filled panels on a dark ground; this one builds from **rules on paper**, the
 * way an account book does — a section is a ruled band, not a box, and nothing
 * here draws a container where a line will do. There are no cards in a 家計簿.
 */

/**
 * A section of the book: a rule, its heading, and the figures beneath.
 *
 * The heading sits *on* the rule rather than above a box, so the page reads as
 * one continuous sheet with divisions ruled onto it.
 */
export function Section({
  title,
  note,
  right,
  children,
}: {
  title: string
  note?: string
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mt-14 first:mt-0">
      <div className="flex items-baseline justify-between gap-4 border-t border-sumi-900 pt-3">
        <h2 className="font-serif text-[19px] font-semibold tracking-[-0.01em]">{title}</h2>
        {right}
      </div>
      {note ? <p className="mt-1 max-w-[68ch] text-[13px] text-sumi-600">{note}</p> : null}
      <div className="mt-6">{children}</div>
    </section>
  )
}

/** A figure with its label beneath, in the serif — the book's own voice. */
export function Figure({
  label,
  value,
  note,
  tone = 'ink',
}: {
  label: string
  value: string
  note?: string
  tone?: 'ink' | 'ok' | 'warn' | 'danger'
}) {
  const tones = {
    ink: 'text-sumi-900',
    ok: 'text-ok-ink',
    warn: 'text-warn-ink',
    danger: 'text-danger-ink',
  } as const
  return (
    <div>
      <div
        className={cn('num font-serif text-[30px] leading-none tracking-[-0.02em]', tones[tone])}
      >
        {value}
      </div>
      <div className="mt-2 text-[12px] uppercase tracking-[0.09em] text-sumi-600">{label}</div>
      {note ? <div className="mt-1 text-[12px] text-sumi-500">{note}</div> : null}
    </div>
  )
}

/**
 * A ruled row. Every list on this page is one of these rather than a card,
 * which is what keeps twelve categories readable as a column of figures.
 */
export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid items-baseline gap-4 border-b border-rule py-2.5', className)}>
      {children}
    </div>
  )
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="border-y border-rule py-10 text-center">
      <p className="text-[14px] text-sumi-600">{title}</p>
      {hint ? <p className="mt-1 text-[13px] text-sumi-500">{hint}</p> : null}
    </div>
  )
}

/**
 * A line in a margin rail: a label and its value, ruled.
 *
 * The book's own way of noting what a page is — the period it covers, the model
 * that produced it, the file it was read from. Kept here rather than copied into
 * each page because three slightly different versions of this row is exactly how
 * a ruled layout stops looking ruled.
 */
export function MetaLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-rule py-[5px]">
      <dt className="text-[11px] uppercase tracking-[0.09em] text-sumi-500">{label}</dt>
      <dd className="num min-w-0 truncate text-right text-[12px] text-sumi-900">{value}</dd>
    </div>
  )
}

/**
 * A status word. Never colour alone — the word carries the meaning and the
 * colour reinforces it, which is also what keeps it legible in forced-colors
 * mode and for a colour-blind reader.
 */
export function Mark({ tone, children }: { tone: 'ok' | 'warn' | 'danger'; children: ReactNode }) {
  const tones = {
    ok: 'text-ok-ink',
    warn: 'text-warn-ink',
    danger: 'text-danger-ink',
  } as const
  return (
    <span className={cn('text-[12px] uppercase tracking-[0.08em]', tones[tone])}>{children}</span>
  )
}
