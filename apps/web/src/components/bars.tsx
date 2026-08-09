import { formatMinor } from '@kakeibo/ledger'
import { cn } from '@/lib/cn'

/**
 * Two bar forms, both monochrome by construction.
 *
 * Spend by category is a **single series** — one measure across twelve
 * categories — so a categorical palette would be encoding identity that
 * position already encodes. One ink is not a limitation imposed by the
 * paletteless direction; it is what this data's job actually asks for. The
 * title names the series, so there is no legend.
 *
 * Bars are horizontal because the labels are words of uneven length: rotated
 * or truncated category names are the usual cost of forcing this into columns.
 */

/** Sorted magnitude across categories. Amounts are direct-labelled, no axis. */
export function SpendBars({
  rows,
  max,
}: {
  rows: { label: string; amountMinor: number; count: number }[]
  max: number
}) {
  return (
    <div className="border-t border-rule-strong">
      {rows.map((row) => {
        const pct = max > 0 ? (row.amountMinor / max) * 100 : 0
        return (
          <div
            key={row.label}
            className="group grid grid-cols-[9.5rem_1fr_auto] items-center gap-4 border-b border-rule py-2"
          >
            <div className="truncate text-[13px] text-sumi-800">{row.label}</div>
            <div className="relative h-3.5">
              <div
                className="h-full rounded-r-[3px] bg-sumi-900/85 transition-[width] duration-500 ease-out group-hover:bg-sumi-900"
                style={{ width: `${Math.max(pct, 0.6)}%` }}
              />
            </div>
            <div className="num text-right text-[13px] tabular-nums text-sumi-900">
              {formatMinor(row.amountMinor)}
              <span className="ml-2 text-[12px] text-sumi-500">{row.count}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Progress against a target.
 *
 * A bar with the target as a rule at 100%, not a ring: a ring makes the
 * remaining amount a shape you have to estimate, where a bar against a line
 * makes over and under a thing you can see at a glance. Over-budget is the one
 * place this page spends colour, and it always ships with the figure beside it.
 */
export function BudgetMeter({
  category,
  actualMinor,
  budgetMinor,
  percentUsed,
}: {
  category: string
  actualMinor: number
  budgetMinor: number
  percentUsed: number
}) {
  const over = percentUsed > 100
  // The track shows up to 125% so an overrun has somewhere to go and its size
  // stays readable rather than being clipped at the target line.
  const scale = 125
  const fill = Math.min((percentUsed / scale) * 100, 100)
  const targetAt = (100 / scale) * 100

  return (
    <div className="grid grid-cols-[9.5rem_1fr_auto] items-center gap-4 border-b border-rule py-2.5">
      <div className="truncate text-[13px] text-sumi-800">{category}</div>
      <div className="relative h-4">
        <div className="absolute inset-0 bg-paper-200" />
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-r-[3px] transition-[width] duration-500 ease-out',
            over ? 'bg-danger-ink' : 'bg-sumi-900/85',
          )}
          style={{ width: `${Math.max(fill, 0.8)}%` }}
        />
        {/* The target. A 2px rule, dark enough to read as a boundary. */}
        <div
          className="absolute inset-y-[-3px] w-0.5 bg-rule-strong"
          style={{ left: `${targetAt}%` }}
          aria-hidden
        />
      </div>
      <div className="num w-40 text-right text-[13px] text-sumi-900">
        {formatMinor(actualMinor)}
        <span className="text-sumi-500"> / {formatMinor(budgetMinor)}</span>
        {over ? (
          <span className="ml-2 text-[12px] uppercase tracking-[0.08em] text-danger-ink">over</span>
        ) : null}
      </div>
    </div>
  )
}
