import { Nav } from '@/components/nav'
import { adminSession } from '@/lib/admin'

/**
 * The machine room: the trace viewer, the eval report, the operator dashboard,
 * and for now the chat itself.
 *
 * Kept in the terminal genre deliberately (spec §7). A trace is a machine's own
 * record of what it did, and monospace, dense and dark is the right register
 * for reading one. Crossing here from a paper surface flips the ground
 * entirely, which is the whole point of the seam.
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
