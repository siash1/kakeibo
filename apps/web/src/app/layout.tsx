import type { Metadata } from 'next'
import { Nav } from '@/components/nav'
import './globals.css'

export const metadata: Metadata = {
  title: 'kakeibo',
  description: 'A personal finance agent built from scratch on the Gemini API.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Nav />
        <main className="mx-auto max-w-6xl px-5 py-6">{children}</main>
      </body>
    </html>
  )
}
