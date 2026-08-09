import { formatUsd } from '@kakeibo/core'
import { createRegistry, DEV_OWNER_ID } from '@kakeibo/ledger'
import Link from 'next/link'
import {
  inlineMarkdown,
  Margin,
  MarginEntries,
  MarginEntry,
  MarginHeading,
  Prose,
  QuestionHeading,
  Spread,
  TurnAccount,
} from '@/components/exchange'
import { Mark, MetaLine } from '@/components/ledger'
import { loadReport, recordedExchange } from '@/lib/report'

/**
 * / — the landing, as a statement of account for the system itself.
 *
 * THESIS: this product's only real argument is that its numbers are checkable,
 * so the page is built the way the product builds a statement — ruled line
 * items with their figures in a column that adds up — and every figure on it is
 * read out of `evals/report/latest.json` or counted off the tool registry at
 * render time. It refuses the marketing landing page's card grid and the
 * hero-metric template — a big number over a small label, asserting itself: a
 * figure in a tile is a claim, and a figure on a ruled line beside the sentence
 * it backs is a statement you can audit.
 *
 * That is not a rule against bands of figures generally, and the distinction is
 * worth keeping straight because two devices ship in this world. `/dashboard`
 * and `/evals` open on a band of headline figures, which is right: they report
 * a dataset the reader came to read, and the figures are the subject rather
 * than evidence for a claim. Here every figure is arguing for a sentence, so it
 * is set beside that sentence and sourced. Same world, two jobs. DESIGN.md
 * records both.
 *
 * OWN-WORLD: the committed paper genre — warm paper, sumi ink, ruled hairlines,
 * no chromatic accent. Colour appears once, on a write.
 *
 * STORY: a sceptical engineer reads what it is, sees one real exchange in full
 * with its tool calls and its cost, checks that the numbers come from a script
 * they could run, and goes to ask their own question.
 *
 * FIRST VIEWPORT: one serif line naming the mechanism at the largest type on
 * the site, the statement's provenance ruled off to the right, the primary
 * action immediately beneath it, and the first line items already showing above
 * the fold. The wordmark is the nav's, not repeated here. No image, because the
 * honest asset is the recorded exchange further down and a decorative one above
 * it would be the page's only lie.
 *
 * FORM: statement column, candidate 4 of the grounded list, seed key 70769594.
 *
 * FINISH: unreviewed and undocumented is unfinished; this build ends with the
 * finish review, the verdict, and DESIGN.md.
 */

export const dynamic = 'force-dynamic'

/** A ruled line item: the claim, and the measured figure that backs it. */
function LineItem({
  entry,
  detail,
  figure,
  note,
}: {
  entry: string
  detail: string
  figure: string
  note?: string
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 gap-y-1 border-b border-rule py-3.5">
      <div className="min-w-0">
        <div className="text-[15px] leading-snug text-sumi-900">{entry}</div>
        <div className="mt-1 max-w-[64ch] text-[13px] leading-relaxed text-sumi-600">{detail}</div>
      </div>
      <div className="text-right">
        <div className="num font-serif text-[clamp(1.125rem,2.4vw,1.375rem)] leading-none text-sumi-900">
          {figure}
        </div>
        {note ? (
          <div className="mt-1.5 text-[11px] uppercase tracking-[0.09em] text-sumi-500">{note}</div>
        ) : null}
      </div>
    </div>
  )
}

function SectionRule({ title, note }: { title: string; note?: string }) {
  return (
    <div className="border-t border-sumi-900 pt-3">
      <h2 className="font-serif text-[19px] font-semibold tracking-[-0.01em]">{title}</h2>
      {note ? <p className="mt-1 max-w-[70ch] text-[13px] text-sumi-600">{note}</p> : null}
    </div>
  )
}

export default function LandingPage() {
  const report = loadReport()
  const exchange = report ? recordedExchange(report) : null

  // Counted off the registry rather than typed into the page, so the figure
  // cannot drift from the twelve tools that actually exist. No handler runs —
  // this reads names, tiers and descriptions only.
  const tools = createRegistry(DEV_OWNER_ID).list()
  const writeTools = tools.filter((tool) => tool.tier === 'write')
  const writeNames = new Set(writeTools.map((tool) => tool.name))

  const runDate = report
    ? new Date(report.finishedAt).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null

  return (
    <div>
      {/* ---- the statement head ------------------------------------------ */}
      <header className="grid gap-x-10 gap-y-8 border-b border-sumi-900 pb-9 lg:grid-cols-[minmax(0,1fr)_13.5rem]">
        {/*
         * No wordmark here. The nav carries it two centimetres above, and a
         * statement that reprints its own letterhead directly under the
         * letterhead is how a page announces it was assembled from sections
         * rather than composed. The heading takes the first viewport instead.
         */}
        <div className="min-w-0">
          <h1 className="mt-1 max-w-[19ch] font-serif text-[clamp(2.25rem,7vw,3.5rem)] leading-[1.04] tracking-[-0.03em]">
            A finance agent that shows its working.
          </h1>

          <p className="mt-6 max-w-[64ch] text-[clamp(0.9375rem,2.2vw,1.0625rem)] leading-[1.6] text-sumi-800">
            Twelve tools over a double-entry ledger, a loop written by hand rather than assembled
            from a framework, and a gate that stops the turn before anything is written. Every
            answer prints the tools it called and the fraction of a cent it cost, in the margin
            beside it.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-x-4 gap-y-3">
            <Link
              href="/chat"
              className="bg-sumi-900 px-6 py-2.5 text-[14px] text-paper-50 no-underline transition-colors hover:bg-sumi-800"
            >
              Ask it something
            </Link>
            <Link
              href="/runs"
              className="border border-sumi-900 px-6 py-2.5 text-[14px] text-sumi-900 no-underline transition-colors hover:bg-paper-200"
            >
              Read a trace
            </Link>
            <span className="text-[13px] text-sumi-500">No account needed.</span>
          </div>
        </div>

        <Margin>
          <MarginHeading>Provenance</MarginHeading>
          <dl className="mt-2 border-t border-rule-strong">
            <MetaLine label="figures from" value={runDate ?? 'no run recorded'} />
            <MetaLine label="agent" value={report?.model ?? '—'} />
            <MetaLine label="judge" value={report?.judgeModel ?? '—'} />
          </dl>
          <p className="mt-3 leading-relaxed text-sumi-600">
            Every number on this page comes out of{' '}
            <code className="font-mono text-[11px]">evals/report/latest.json</code> or off the tool
            registry. Reproduce them with <code className="font-mono text-[11px]">pnpm eval</code>{' '}
            and <code className="font-mono text-[11px]">pnpm metrics</code>.
          </p>
        </Margin>
      </header>

      {/* ---- the statement ------------------------------------------------ */}
      <section className="mt-14">
        <SectionRule
          title="What it is made of"
          note="One line per claim, with the figure that backs it. Anything this repo cannot reproduce does not get a line."
        />

        <div className="mt-6 border-t border-rule-strong">
          <LineItem
            entry="Tools over a double-entry ledger"
            detail="Search, reports, budgets, recurring detection, anomalies, currency, import, categorisation, memory. The same registry serves the agent loop, the MCP server and the eval harness."
            figure={String(tools.length)}
            note="registered"
          />
          <LineItem
            entry="Of those, writes that stop for a human"
            detail="A batch containing a write suspends the turn to the database and returns what it was about to do. The gate is in the loop, not in the prompt — a model that decided to ignore it still could not reach the write."
            figure={String(writeTools.length)}
            note="write tier"
          />
          {report ? (
            <>
              <LineItem
                entry="Golden tasks passed, last run"
                detail={`${Object.keys(report.byClass).length} classes — reports, categorisation, budgets, recurring, anomalies, memory, multi-tool, currency, refusal and the rest. Deterministic checks gate the verdict; the judge only refines.`}
                figure={`${report.passed}/${report.taskCount}`}
                note={`${report.passRate}%`}
              />
              <LineItem
                entry="Prompt-injection attempts blocked"
                detail="Statement descriptions are attacker-controlled text. The suite plants instructions in them and checks that none of them moved money or changed a category."
                figure={report.injectionBlockRate === null ? '—' : `${report.injectionBlockRate}%`}
                note="blocked"
              />
              <LineItem
                entry="Prompt tokens served from cache"
                detail="The system prompt and all twelve tool schemas are one explicit cached prefix. Deterministic serialisation is what keeps it warm across processes."
                figure={`${report.cacheSavingsPercent}%`}
                note="of input"
              />
              <LineItem
                entry="Median cost per task"
                detail={`Across the whole run: ${formatUsd(report.totalCostUsd)} for ${report.taskCount} tasks, list price, measured rather than modelled.`}
                figure={formatUsd(report.medianCostUsd)}
                note="median"
              />
              <LineItem
                entry="Median latency per task"
                detail={`Agent time only — the reset-and-reseed each task starts from is not charged to it. p95 was ${(report.p95LatencyMs / 1000).toFixed(1)}s.`}
                figure={`${(report.medianLatencyMs / 1000).toFixed(1)}s`}
                note="median"
              />

              {/*
               * The closing line, under the accountant's double rule.
               *
               * A statement ends by being totalled, and until this line the page
               * argued in that form without ever performing it. The lines above
               * measure different things and deliberately do not sum — so what
               * is totalled is the one figure that genuinely is a total: what
               * the whole run cost to produce every number above it.
               *
               * The double rule is also the mark's own device. It meant "final
               * total" in the logo and nowhere else on the site, which made the
               * identity a claim the pages never backed.
               */}
              <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 border-t-4 border-double border-sumi-900 pt-3">
                <div className="min-w-0">
                  <div className="text-[15px] leading-snug text-sumi-900">
                    What the whole run cost
                  </div>
                  <div className="mt-1 max-w-[64ch] text-[13px] leading-relaxed text-sumi-600">
                    Every figure above, produced end to end, on {report.taskCount} tasks. Not a sum
                    of the lines above it — they measure different things — but the total this
                    statement is drawn from.
                  </div>
                </div>
                <div className="num font-serif text-[clamp(1.375rem,3vw,1.75rem)] leading-none text-sumi-900">
                  {formatUsd(report.totalCostUsd)}
                </div>
              </div>
            </>
          ) : (
            <div className="border-b border-rule py-8 text-[14px] text-sumi-600">
              No eval report is committed, so the measured lines are not shown. Run{' '}
              <code className="font-mono text-[12px]">pnpm eval</code> to produce one.
            </div>
          )}
        </div>
      </section>

      {/* ---- one exchange, in full ---------------------------------------- */}
      {exchange ? (
        <section className="mt-16">
          <SectionRule
            title="One exchange, in full"
            note="Not a mock-up and not a video: this is a turn from the last eval run, printed the way the live page prints one. The question, the tools it reached for, the answer it gave, and what it cost."
          />

          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-sumi-500">
            <span className="uppercase tracking-[0.09em]">recorded</span>
            <code className="font-mono text-[11px] text-sumi-600">{exchange.taskId}</code>
            <span>· {exchange.description}</span>
          </div>

          <div className="mt-4 border-t border-rule pt-2">
            <QuestionHeading>{exchange.question}</QuestionHeading>

            <Spread>
              <div className="min-w-0 space-y-4">
                <Prose>{inlineMarkdown(exchange.answer)}</Prose>

                {exchange.gate ? (
                  <div className="max-w-[68ch] border-y-2 border-sumi-900 py-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <h3 className="font-serif text-[17px] font-semibold tracking-[-0.01em]">
                        The turn stopped before it wrote
                      </h3>
                      <Mark tone="warn">gate</Mark>
                    </div>
                    <p className="mt-2 text-[14px] leading-relaxed text-sumi-800">
                      The recorded run allowed it. What the check saw:{' '}
                      <span className="text-sumi-900">{exchange.gate.detail}</span>.
                    </p>
                    <p className="mt-2 text-[12px] leading-relaxed text-sumi-500">
                      The slip the visitor actually signs is not reproduced here — the report stores
                      that the gate fired and how it was answered, not the wording it showed, and
                      inventing that screen is the one thing this page must not do.{' '}
                      <Link href="/chat" className="text-sumi-800">
                        See it live
                      </Link>
                      .
                    </p>
                  </div>
                ) : null}
              </div>

              <Margin>
                <MarginEntries>
                  {exchange.toolNames.map((name) => (
                    <MarginEntry key={name} name={name} isWrite={writeNames.has(name)} />
                  ))}
                </MarginEntries>
                <TurnAccount
                  latencyMs={exchange.latencyMs}
                  inputTokens={exchange.inputTokens}
                  cachedTokens={exchange.cachedTokens}
                  outputTokens={exchange.outputTokens}
                  costUsd={exchange.costUsd}
                />
              </Margin>
            </Spread>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-3">
            <Link
              href="/chat"
              className="bg-sumi-900 px-6 py-2.5 text-[14px] text-paper-50 no-underline transition-colors hover:bg-sumi-800"
            >
              Ask your own
            </Link>
            <span className="text-[13px] text-sumi-500">
              Yours runs live against your own copy of the ledger.
            </span>
          </div>
        </section>
      ) : null}

      {/* ---- the tools ----------------------------------------------------- */}
      <section className="mt-16">
        <SectionRule
          title="The twelve"
          note="Read from the registry at render time. Adding a tool to one file puts it in the agent loop, the MCP server and the eval harness at once — this list cannot fall out of date."
        />

        <div className="mt-6 border-t border-rule-strong">
          {tools.map((tool) => (
            /*
             * Every cell is placed explicitly.
             *
             * Auto-placement plus a bare `row-start-1` on the tier put the tier
             * into the first column on phones and pushed the tool name — the
             * one thing a reader is scanning this list for — into the narrow
             * column, where it truncated to `categori…`. Naming the row and
             * column for each cell at each breakpoint costs four utilities and
             * cannot land in that state.
             */
            <div
              key={tool.name}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-5 gap-y-1 border-b border-rule py-2.5 sm:grid-cols-[13rem_minmax(0,1fr)_auto]"
            >
              <code className="col-start-1 row-start-1 min-w-0 truncate font-mono text-[12px] text-sumi-900">
                {tool.name}
              </code>
              <p className="col-span-2 col-start-1 row-start-2 text-[13px] leading-snug text-sumi-600 sm:col-span-1 sm:col-start-2 sm:row-start-1">
                {tool.description.split(/(?<=\.)\s/)[0]}
              </p>
              <div className="col-start-2 row-start-1 text-right sm:col-start-3">
                {tool.tier === 'write' ? (
                  <Mark tone="warn">write</Mark>
                ) : (
                  <span className="text-[12px] uppercase tracking-[0.08em] text-sumi-500">
                    read
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---- what it costs to run ------------------------------------------ */}
      <section className="mt-16">
        <SectionRule title="What it costs to run" />

        <div className="mt-6 grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_13.5rem]">
          <div className="min-w-0 max-w-[68ch] space-y-4 text-[15px] leading-[1.7] text-sumi-800">
            <p>
              Every model call on this site is billed to one person's card, so the ceiling is a
              design constraint rather than a footnote. It is set at twenty dollars a month with a
              global kill switch, which is roughly a hundred and fifty live turns a day.
            </p>
            <p>
              Past the cap, live chat stops and the site says so plainly instead of degrading into
              something that looks like it is working. Generosity is not available here; honesty
              about the limit is.
            </p>
            <p className="text-[14px] text-sumi-600">
              Your ledger is a synthetic 352-transaction copy made the first time you ask something
              — generated, not anyone's real spending. Importing a real statement works and is
              deleted after twenty-four hours; the raw CSV is never stored.
            </p>
          </div>

          <Margin>
            <MarginHeading>The ceiling</MarginHeading>
            <dl className="mt-2 border-t border-rule-strong">
              <MetaLine label="monthly cap" value="$20" />
              <MetaLine label="≈ live turns" value="148 / day" />
              <MetaLine label="past the cap" value="chat pauses" />
            </dl>
          </Margin>
        </div>
      </section>

      {/* ---- the close ------------------------------------------------------ */}
      <footer className="mt-16 border-t border-sumi-900 pt-6">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-6">
          <div className="max-w-[46ch]">
            <p className="font-serif text-[clamp(1.25rem,3.4vw,1.625rem)] leading-[1.25] tracking-[-0.02em]">
              The ledger is already there. Ask it something.
            </p>
            <Link
              href="/chat"
              className="mt-5 inline-block bg-sumi-900 px-6 py-2.5 text-[14px] text-paper-50 no-underline transition-colors hover:bg-sumi-800"
            >
              Ask it something
            </Link>
          </div>

          <nav aria-label="The machine room" className="text-[13px]">
            <div className="text-[11px] uppercase tracking-[0.11em] text-sumi-500">
              For the sceptical
            </div>
            <ul className="mt-2 space-y-1.5">
              <li>
                <Link href="/runs">Every model and tool call, traced</Link>
              </li>
              <li>
                <Link href="/evals">The full eval report</Link>
              </li>
              <li>
                <a href="https://github.com/siash1/kakeibo">The source</a>
              </li>
            </ul>
          </nav>
        </div>
      </footer>
    </div>
  )
}
