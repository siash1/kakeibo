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
  // `email` on a password account is self-asserted: `emailAndPassword` is
  // enabled with no `requireEmailVerification` (see auth.ts), and sign-up is
  // public at /api/auth/sign-up/email. Without this check, an allowlist entry
  // is satisfiable by anyone who registers that address first — not by
  // proving they control it. See docs/continue-here.md for what has to be
  // true (Google OAuth or a real verification flow) before ADMIN_EMAILS is
  // set on a public deploy, and the residual risk even after this check.
  if (!viewer.emailVerified) return undefined
  return assertAdmin(viewer.email)
}
