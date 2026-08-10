import type { Metadata } from 'next'
import './globals.css'

/**
 * PRODUCT.md says the visitor arrives "in a tab opened from a CV, a README or a
 * link in a message", which makes the link preview the first impression the site
 * gets to make and, until now, the only surface with no design on it at all.
 *
 * `opengraph-image.jpg`, `icon.png` and `apple-icon.png` sit beside this file as
 * Next file conventions, so the tags and their dimensions are emitted from the
 * files themselves rather than hand-written here and left to drift. The card is
 * a generated sheet of ledger paper with the real Source Serif 4 composited over
 * it — the model produced the material, never the lettering, because a model
 * rendering type produces text that is almost right, which on a wordmark is
 * worse than no image.
 *
 * The figures on it are the same measured ones the landing page carries. If they
 * change, `pnpm eval` changes them, and the card has to be regenerated with it.
 */
export const metadata: Metadata = {
  metadataBase: new URL(process.env.BETTER_AUTH_URL ?? 'http://localhost:3000'),
  title: {
    default: 'kakeibo: a finance agent that shows its working',
    template: '%s · kakeibo',
  },
  description:
    'A personal finance agent built from scratch on the Gemini API: twelve tools over a double-entry ledger, a hand-written loop, and a gate that stops before anything is written.',
  applicationName: 'kakeibo',
  openGraph: {
    type: 'website',
    siteName: 'kakeibo',
    title: 'kakeibo: a finance agent that shows its working',
    description:
      'Twelve tools over a double-entry ledger, a hand-written loop, and a gate that stops before anything is written. Every answer prints what it cost.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'kakeibo: a finance agent that shows its working',
    description:
      'Twelve tools over a double-entry ledger, a hand-written loop, and a gate that stops before anything is written. Every answer prints what it cost.',
  },
}

/**
 * The root owns the document and nothing else.
 *
 * Neither genre's ground is set here. `(paper)` and `(terminal)` each paint
 * their own full-height surface, which is what lets two visual worlds live in
 * one app without a nested route fighting the root for the background.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  )
}
