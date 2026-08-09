import { Nav } from '@/components/nav'
import { adminSession } from '@/lib/admin'

/**
 * The machine room: the trace viewer and the operator dashboard.
 *
 * Kept in the terminal genre deliberately (spec §7). A trace is a machine's own
 * record of what it did, and monospace, dense and dark is the right register
 * for reading one. Crossing here from a paper surface flips the ground
 * entirely, which is the whole point of the seam.
 *
 * Everything a visitor came for lives in `(paper)`. What is left here is
 * addressed to whoever is reading the machine, not to whoever is using it.
 */
export default async function TerminalLayout({ children }: { children: React.ReactNode }) {
  // Nav is a client component and cannot read the session; this is a server
  // component and can, so the operator link's visibility is decided here.
  const isOperator = (await adminSession()) !== undefined

  return (
    <div data-genre="terminal" className="min-h-screen">
      <Nav showAdmin={isOperator} />
      <main className="mx-auto max-w-6xl px-5 py-6">{children}</main>
    </div>
  )
}
