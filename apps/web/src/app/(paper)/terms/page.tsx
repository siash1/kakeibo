import Link from 'next/link'
import { Section } from '@/components/ledger'

/**
 * /terms — short, because the honest version is short.
 *
 * This is a portfolio piece with no payment, no account and no promise of
 * availability. Terms written to sound like a company's would be the only
 * dishonest page on a site whose entire argument is that its claims are
 * checkable.
 */
export const metadata = { title: 'Terms' }

export default function TermsPage() {
  return (
    <div className="max-w-[68ch]">
      {/* No rule under the header — see the note on /privacy. */}
      <header>
        <h1 className="font-serif text-[clamp(1.75rem,5vw,2.5rem)] leading-[1.1] tracking-[-0.025em]">
          Terms
        </h1>
        <p className="mt-3 text-[15px] leading-[1.6] text-sumi-600">
          Short, because the honest version is short.
        </p>
      </header>

      <Section title="What this is">
        <p className="text-[15px] leading-[1.7] text-sumi-900">
          A demonstration of an AI agent built on a double-entry ledger, run by one person as a
          portfolio piece. It is not a financial service, not advice, and not a product. Nothing it
          tells you about money should be acted on.
        </p>
      </Section>

      <Section title="What it costs, and what that buys you">
        <p className="text-[15px] leading-[1.7] text-sumi-900">
          Nothing, and correspondingly little. Every model call is billed to one person&rsquo;s card
          against a fixed monthly ceiling. When the ceiling is reached, live chat stops until the
          next day and the site says so. There is no uptime commitment and no support.
        </p>
      </Section>

      {/*
       * The inline link is explicitly underlined. Tailwind's preflight sets
       * `text-decoration: inherit` on anchors, so the rule in globals.css that
       * offsets a paper link's underline never has an underline to offset — and
       * an inline link in sumi-900 prose, on a site with no accent colour, is
       * otherwise indistinguishable from the sentence around it.
       */}
      <Section title="Your data">
        <p className="text-[15px] leading-[1.7] text-sumi-900">
          Deleted automatically within 24 hours, or immediately if you ask.{' '}
          <Link href="/privacy" className="underline">
            The privacy page
          </Link>{' '}
          describes what is stored and who can read it — including the part where the operator can
          see your ledger contents in a diagnostic trace. Please read it before importing anything
          real.
        </p>
      </Section>

      <Section title="Liability">
        <p className="text-[15px] leading-[1.7] text-sumi-900">
          Provided as-is, with no warranty of any kind. The source is MIT licensed and public; if
          something here matters to you, read it.
        </p>
      </Section>
    </div>
  )
}
