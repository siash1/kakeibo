import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * The handful of primitives the three pages need, in the shadcn/ui idiom
 * (copy-in components over cva + tailwind-merge rather than a component
 * dependency). Three pages did not justify pulling in the full Radix surface.
 */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-lg border border-ink-800 bg-ink-900/60', className)}>
      {children}
    </div>
  )
}

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'
  className?: string
  children: ReactNode
}) {
  const tones = {
    neutral: 'border-ink-700 text-ink-300',
    accent: 'border-accent-dim text-accent',
    ok: 'border-ok/40 text-ok',
    warn: 'border-warn/40 text-warn',
    danger: 'border-danger/40 text-danger',
  } as const
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[11px] leading-none',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-ink-500">{label}</div>
      <div className="num mt-1 text-lg text-ink-100">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-ink-500">{hint}</div> : null}
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-800 px-6 py-12 text-center">
      <p className="text-sm text-ink-300">{title}</p>
      {hint ? <p className="mt-1 text-xs text-ink-500">{hint}</p> : null}
    </div>
  )
}

export function statusTone(status: string): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (status === 'ok') return 'ok'
  if (status === 'blocked') return 'warn'
  if (status === 'error') return 'danger'
  return 'neutral'
}
