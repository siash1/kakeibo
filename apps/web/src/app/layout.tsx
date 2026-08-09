import type { Metadata } from 'next'
import { Nav } from '@/components/nav'
import { adminSession } from '@/lib/admin'
import './globals.css'

export const metadata: Metadata = {
  title: 'kakeibo',
  description: 'A personal finance agent built from scratch on the Gemini API.',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Nav is a client component and cannot read the session; the layout is a
  // server component and can, so the operator link's visibility is decided
  // here and passed down as a prop.
  const isOperator = (await adminSession()) !== undefined

  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Nav showAdmin={isOperator} />
        <main className="mx-auto max-w-6xl px-5 py-6">{children}</main>
      </body>
    </html>
  )
}
