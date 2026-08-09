import { DeleteEverything } from '@/components/delete-everything'
import { Section } from '@/components/ledger'

/**
 * /privacy — what is stored, for how long, and who can read it.
 *
 * Design spec §9.6 is the obligation this page exists to discharge: trace
 * payloads contain tool arguments and results, so an operator reading a trace
 * is reading that visitor's ledger contents. That sentence is not buried, and
 * it is not softened.
 *
 * The delete control lives here rather than on a settings page because there is
 * no account to have settings for, and because a promise and the button that
 * honours it belong on the same page.
 */
export const metadata = { title: 'Privacy' }

export default function PrivacyPage() {
  return (
    <div className="max-w-[68ch]">
      <header className="border-b border-sumi-900 pb-6">
        <h1 className="font-serif text-[clamp(1.75rem,5vw,2.5rem)] leading-[1.1] tracking-[-0.025em]">
          Privacy
        </h1>
        <p className="mt-3 text-[15px] leading-[1.6] text-sumi-600">
          kakeibo is a demonstration of a piece of engineering, not a financial service. This page
          says exactly what it keeps and who can see it.
        </p>
      </header>

      <Section title="What you get when you arrive">
        <p className="text-[15px] leading-[1.7] text-sumi-900">
          A copy of a 352-transaction synthetic ledger, generated for this project and belonging to
          nobody. It is created the first time you ask the agent something or open the dashboard,
          not when you load a page, so visiting costs nothing. You are signed in anonymously to hold
          it — there are no accounts here and no way to make one.
        </p>
      </Section>

      <Section title="What is stored">
        <ul className="space-y-3 text-[15px] leading-[1.7] text-sumi-900">
          <li>Your copy of the ledger, and anything you change in it.</li>
          <li>
            Your conversation with the agent, so a reload picks the thread up rather than starting a
            second one.
          </li>
          <li>
            A trace of every model call and tool call in that conversation — what was asked, which
            tools ran, what they returned, and what it cost.
          </li>
          <li>
            An approximate city-level location derived from your request&rsquo;s IP address, for
            operational analytics. No browser location prompt is ever shown, and nothing about the
            site behaves differently because of it.
          </li>
          <li>
            A salted hash of your IP address, used to count messages per day against the
            site&rsquo;s cost ceiling. The address itself is never written down.
          </li>
        </ul>
      </Section>

      <Section title="Who can read it">
        <p className="text-[15px] leading-[1.7] text-sumi-900">
          The operator can. Traces contain the arguments and results of every tool call, which means
          a trace of your conversation contains the contents of your ledger — the merchants, the
          amounts, the dates. An operator reading a trace to debug the agent is reading your data.
          That is a real consequence of building the thing this way, and it is stated here rather
          than buried in the architecture.
        </p>
        <p className="mt-4 text-[15px] leading-[1.7] text-sumi-900">
          Nothing is shared with anyone else. Prompts and tool results go to Google&rsquo;s Gemini
          API to be answered, and to nowhere else.
        </p>
      </Section>

      <Section title="If you import a real statement">
        <p className="text-[15px] leading-[1.7] text-sumi-900">
          You may, and the raw CSV is never written to disk or to the database — it is parsed in
          memory and only the derived rows are stored. Those rows are deleted with everything else
          after 24 hours. Given the paragraph above about traces, importing a real statement is not
          advised.
        </p>
      </Section>

      <Section
        title="How long it lasts"
        note="Twenty-four hours from your first request, swept nightly. There is no way to extend it, because there is no account to attach it to."
      >
        <DeleteEverything />
      </Section>

      <footer className="mt-16 border-t border-rule pt-4 text-[12px] leading-[1.5] text-sumi-500">
        The source is public at{' '}
        <a href="https://github.com/siash1/kakeibo">github.com/siash1/kakeibo</a>, including
        everything described here.
      </footer>
    </div>
  )
}
