import { Nav } from '@/components/nav'
import { adminSession } from '@/lib/admin'

/**
 * 家計簿 — the household account book.
 *
 * Warm paper, sumi ink, ruled hairlines, and no chromatic accent: emphasis is
 * carried by weight, scale and the rules themselves. Colour appears only where
 * it means something (over budget, an anomaly, an error), which is why it still
 * reads as a signal when it does.
 */
export default async function PaperLayout({ children }: { children: React.ReactNode }) {
  const isOperator = (await adminSession()) !== undefined

  return (
    <div data-genre="paper" className="min-h-screen">
      <Nav showAdmin={isOperator} />
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  )
}
