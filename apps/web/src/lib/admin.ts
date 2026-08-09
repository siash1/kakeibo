import { type AdminSession, assertAdmin } from '@kakeibo/ledger'
import { viewerOwner } from '@/lib/owner'

/**
 * The operator's session, or undefined.
 *
 * Callers respond to undefined with `notFound()`, never a 403. A 403 confirms
 * the route exists, which is free reconnaissance for anyone probing a public
 * site; a 404 is indistinguishable from a typo.
 */
export async function adminSession(): Promise<AdminSession | undefined> {
  const viewer = await viewerOwner()
  // An anonymous visitor has a synthetic email on a domain nobody controls, so
  // this is not merely belt and braces: it stops an allowlist entry from ever
  // being satisfiable by a generated address.
  if (!viewer || viewer.isAnonymous) return undefined
  return assertAdmin(viewer.email)
}
