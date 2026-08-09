import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'kakeibo',
  description: 'A personal finance agent built from scratch on the Gemini API.',
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
