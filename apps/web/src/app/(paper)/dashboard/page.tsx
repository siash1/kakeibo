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
          href="/chat"
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
  /*
   * Expenses only, for the same reason "Where it went" says so out loud.
   *
   * `detectRecurring` finds anything billing on a cadence, and salary and
   * interest are exactly that. Income postings are negative, so summing every
   * monthly merchant reported the subscriptions figure as -₹1,50,472.03 — a
   * salary drowning nine real subscriptions — under a label that says
   * "Monthly subscriptions". It rendered without erroring and was wrong on
   * every month, which is why nobody caught it until the page was looked at.
   */
  const monthlySubscriptions = recurring.filter(
    (row) => row.cadence === 'monthly' && row.averageAmountMinor > 0,
  )
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
        note="Grouped by merchant with reference numbers stripped, so NETFLIX.COM 4429183 and NETFLIX.COM 5510022 count as one subscription rather than two. Money arriving on a cadence — salary, interest — is recurring too, and shows here as a negative."
      >
        {recurring.length === 0 ? (
          <Empty
            title="Nothing recurring found yet."
            hint="It takes three occurrences to call something recurring."
          />
        ) : (
          <div className="border-t border-rule-strong">
            {recurring.map((row) => (
              /*
               * The merchant takes the width, and the constants move under it.
               *
               * With four columns on one line at 390px the fixed ones ate 282
               * of them and the merchant was left 24 to 57 pixels: SALARY
               * CREDIT ACME and both CULT FIT rows all rendered as "CULT …",
               * indistinguishable from each other. `monthly` and `6×` repeat on
               * nearly every row, so they are the cheapest thing on the line to
               * demote and the merchant is the only thing here worth reading.
               */
              <Row
                key={row.merchant}
                className="grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[1fr_9rem_6rem_auto]"
              >
                <div className="min-w-0 truncate text-[13px] text-sumi-900">{row.merchant}</div>
                <div className="order-last col-span-2 text-[12px] text-sumi-600 sm:order-none sm:col-span-1">
                  {row.cadence}
                  <span className="num ml-2 text-sumi-500 sm:hidden">{row.occurrences}×</span>
                </div>
                <div className="num hidden text-[12px] text-sumi-500 sm:block">
                  {row.occurrences}×
                </div>
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
              /*
               * Same crush as Recurring, and every cell placed explicitly.
               *
               * An earlier pass reflowed this with `order` utilities and left
               * the amount right-aligned inside the *first* column rather than
               * to the row rule — stranded mid-row, hanging on none of the
               * figure columns every other amount on the page uses. On a phone
               * the two figures share the first line (date left, amount right,
               * on the rule), the description takes the second, and the kind
               * sits under it.
               */
              <Row
                key={row.transactionId}
                className="grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[5.5rem_1fr_6rem_auto]"
              >
                <div className="num col-start-1 row-start-1 text-[12px] text-sumi-500 sm:row-auto">
                  {row.date.slice(5)}
                </div>
                <div className="col-span-2 col-start-1 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
                  <div className="text-[13px] text-sumi-900">{row.description}</div>
                  <div className="mt-0.5 text-[12px] text-sumi-600">{row.detail}</div>
                </div>
                <div className="col-span-2 col-start-1 row-start-3 sm:col-span-1 sm:col-start-3 sm:row-start-1">
                  <Mark tone={row.kind === 'refund' ? 'ok' : 'warn'}>{row.kind}</Mark>
                </div>
                <div className="num col-start-2 row-start-1 text-right text-[13px] text-sumi-900 sm:col-start-4">
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
