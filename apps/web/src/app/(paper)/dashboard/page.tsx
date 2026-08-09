import {
  budgetStatus,
  detectRecurring,
  ensureLedger,
  flagAnomalies,
  formatMinor,
  monthToPeriod,
  shiftMonth,
  spendReport,
} from '@kakeibo/ledger'
import { BudgetMeter, SpendBars } from '@/components/bars'
import { Empty, Figure, Mark, Row, Section } from '@/components/ledger'
import { viewerOwner } from '@/lib/owner'

/**
 * The ledger, read rather than asked.
 *
 * Everything on this page is available through the agent by typing a question;
 * this is the same data laid out so it can be taken in at a glance. Nothing
 * here is a number the tools cannot produce — the page is a view of the ledger,
 * not a second source of truth.
 *
 * The seed corpus runs January to June 2025, so the month shown is the last one
 * with data rather than the real calendar month. Saying so on the page is
 * cheaper than a visitor concluding their ledger is empty.
 */

export const dynamic = 'force-dynamic'

/**
 * The seed corpus runs 2025-01 to 2025-06. The page opens on the last month
 * with data rather than the real calendar month, and lets you walk back through
 * the others — a ledger that can only show one month is not a ledger.
 *
 * Walking matters for more than completeness: the planted anomalies are in
 * April, so a dashboard pinned to June would show the detector finding nothing
 * and read as though it did not work.
 */
const FIRST_MONTH = '2025-01'
const LAST_MONTH = '2025-06'

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

function readMonth(raw: string | undefined): string {
  if (!raw || !/^\d{4}-\d{2}$/.test(raw)) return LAST_MONTH
  if (raw < FIRST_MONTH || raw > LAST_MONTH) return LAST_MONTH
  return raw
}

function monthLabel(month: string): string {
  const [year, index] = month.split('-')
  return `${MONTH_NAMES[Number(index) - 1]} ${year}`
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const viewer = await viewerOwner()

  if (!viewer) {
    return (
      <div className="mx-auto max-w-[52ch] py-24 text-center">
        <h1 className="font-serif text-[34px] leading-[1.15] tracking-[-0.02em]">
          Your ledger, at a glance.
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-sumi-600">
          A ledger is created the first time you ask the agent something. Start a conversation and
          this page fills in.
        </p>
        <a
          href="/"
          className="mt-8 inline-block border-b border-sumi-900 pb-0.5 font-serif text-[16px] no-underline"
        >
          Ask about your ledger →
        </a>
      </div>
    )
  }

  const MONTH = readMonth((await searchParams).month)
  const previous = MONTH > FIRST_MONTH ? shiftMonth(MONTH, -1) : null
  const next = MONTH < LAST_MONTH ? shiftMonth(MONTH, 1) : null

  const owner = viewer.owner
  await ensureLedger(owner)

  const [categories, budgets, recurring, anomalies] = await Promise.all([
    spendReport(owner, monthToPeriod(MONTH), 'category'),
    budgetStatus(owner, MONTH),
    detectRecurring(owner, 3),
    flagAnomalies(owner, MONTH),
  ])

  const spent = categories.reduce((sum, row) => sum + row.totalMinor, 0)
  const largest = categories[0]
  const maxCategory = Math.max(...categories.map((row) => row.totalMinor), 0)
  const withBudget = budgets.filter(
    (row): row is typeof row & { budgetMinor: number; percentUsed: number } =>
      row.budgetMinor !== null && row.percentUsed !== null,
  )
  const monthlySubscriptions = recurring.filter((row) => row.cadence === 'monthly')
  const subscriptionTotal = monthlySubscriptions.reduce(
    (sum, row) => sum + row.averageAmountMinor,
    0,
  )

  return (
    <div>
      <header className="flex items-end justify-between gap-6 border-b border-sumi-900 pb-6">
        <div>
          <h1 className="font-serif text-[40px] leading-[1.05] tracking-[-0.025em]">
            {monthLabel(MONTH)}
          </h1>
          <p className="mt-2 max-w-[58ch] text-[13px] text-sumi-600">
            352 synthetic transactions, January to June 2025. Generated, not anyone's real spending.
          </p>
        </div>
        <nav aria-label="Month" className="flex shrink-0 items-center gap-4 pb-1 text-[13px]">
          {previous ? (
            <a href={`/dashboard?month=${previous}`} className="no-underline hover:underline">
              ← {monthLabel(previous).split(' ')[0]}
            </a>
          ) : (
            <span className="text-sumi-500/60">← earlier</span>
          )}
          {next ? (
            <a href={`/dashboard?month=${next}`} className="no-underline hover:underline">
              {monthLabel(next).split(' ')[0]} →
            </a>
          ) : (
            <span className="text-sumi-500/60">later →</span>
          )}
        </nav>
      </header>

      <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-8 sm:grid-cols-4">
        <Figure label="Spent" value={formatMinor(spent)} />
        <Figure
          label="Largest category"
          value={largest ? formatMinor(largest.totalMinor) : '—'}
          note={largest?.group}
        />
        <Figure
          label="Monthly subscriptions"
          value={formatMinor(subscriptionTotal)}
          note={`${monthlySubscriptions.length} merchant${monthlySubscriptions.length === 1 ? '' : 's'}`}
        />
        <Figure
          label="Flagged"
          value={String(anomalies.length)}
          tone={anomalies.length > 0 ? 'warn' : 'ink'}
          note={anomalies.length === 0 ? 'nothing unusual' : 'needs a look'}
        />
      </div>

      <Section
        title="Where it went"
        note="Expense accounts only. Income postings are negative and would otherwise net against spending, which is the usual way a month reports cheaper than it was."
      >
        {categories.length === 0 ? (
          <Empty title="No spending recorded this month." />
        ) : (
          <SpendBars
            max={maxCategory}
            rows={categories.map((row) => ({
              label: row.group,
              amountMinor: row.totalMinor,
              count: row.transactionCount,
            }))}
          />
        )}
      </Section>

      <Section
        title="Against budget"
        note="The rule marks the budget. A bar past it is an overrun, and the amount is beside it rather than implied by the shape."
      >
        {withBudget.length === 0 ? (
          <Empty
            title="No budgets set for this month."
            hint="Ask the agent to set one — it will show you what will change before it writes."
          />
        ) : (
          <div className="border-t border-rule-strong">
            {withBudget.map((row) => (
              <BudgetMeter
                key={row.category}
                category={row.category}
                actualMinor={row.actualMinor}
                budgetMinor={row.budgetMinor}
                percentUsed={row.percentUsed}
              />
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Recurring"
        note="Grouped by merchant with reference numbers stripped, so NETFLIX.COM 4429183 and NETFLIX.COM 5510022 count as one subscription rather than two."
      >
        {recurring.length === 0 ? (
          <Empty
            title="Nothing recurring found yet."
            hint="It takes three occurrences to call something recurring."
          />
        ) : (
          <div className="border-t border-rule-strong">
            {recurring.map((row) => (
              <Row
                key={row.merchant}
                className="grid-cols-[1fr_7rem_5rem_auto] sm:grid-cols-[1fr_9rem_6rem_auto]"
              >
                <div className="truncate text-[13px] text-sumi-900">{row.merchant}</div>
                <div className="text-[12px] text-sumi-600">{row.cadence}</div>
                <div className="num text-[12px] text-sumi-500">{row.occurrences}×</div>
                <div className="num text-right text-[13px] text-sumi-900">
                  {formatMinor(row.averageAmountMinor)}
                </div>
              </Row>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Worth a look"
        note="Three different things, reported separately: a charge far above that category's own six-month average, the same charge twice in a day, and money that came back."
      >
        {anomalies.length === 0 ? (
          <Empty
            title="Nothing unusual this month."
            hint="April has the planted ones — walk back and the detector has something to find."
          />
        ) : (
          <div className="border-t border-rule-strong">
            {anomalies.map((row) => (
              <Row key={row.transactionId} className="grid-cols-[5.5rem_1fr_6rem_auto]">
                <div className="num text-[12px] text-sumi-500">{row.date.slice(5)}</div>
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-sumi-900">{row.description}</div>
                  <div className="mt-0.5 text-[12px] text-sumi-600">{row.detail}</div>
                </div>
                <div>
                  <Mark tone={row.kind === 'refund' ? 'ok' : 'warn'}>{row.kind}</Mark>
                </div>
                <div className="num text-right text-[13px] text-sumi-900">
                  {formatMinor(row.amountMinor)}
                </div>
              </Row>
            ))}
          </div>
        )}
      </Section>

      <footer className="mt-16 border-t border-rule pt-4 text-[12px] text-sumi-500">
        Every figure here comes from the same repository functions the agent's tools call. Ask it
        anything on this page and it will reach for the same data.
      </footer>
    </div>
  )
}
