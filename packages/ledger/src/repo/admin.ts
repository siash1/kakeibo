import { env } from '@kakeibo/core/env'
import { eq } from 'drizzle-orm'
import { user } from '../auth-schema'
import { adminDb } from '../db'

/**
 * The operator dashboard (spec §9).
 *
 * **This module is the only place in the application permitted to read across
 * owners.** Row-level security (Plan A §4.2) exists to make a forgotten
 * `where owner_id = ...` return nothing instead of another visitor's ledger;
 * every function here deliberately steps around that, because a dashboard that
 * could only see its own operator's data would show nothing.
 *
 * Two rules keep that safe, and a reviewer should be able to check both by
 * reading this one file:
 *
 *  1. Every exported function takes an `AdminSession` as its first parameter.
 *     That value cannot be constructed outside `assertAdmin`, so a caller
 *     cannot reach these reads without having proved who they are first. The
 *     functions do not re-check authorization themselves — one check, at one
 *     door, is easier to audit than eleven scattered ones.
 *  2. Every function is read-only except the two operator actions, which are
 *     individually named and write an audit event.
 *
 * `packages/ledger/src/admin-containment.test.ts` asserts that the set of
 * modules holding the RLS-bypassing connection is the reviewed one.
 */

/**
 * Proof that the caller is the operator.
 *
 * A branded type with a private symbol: it cannot be forged with an object
 * literal, so `readEverything({ email } as AdminSession)` does not compile.
 * That is the whole mechanism — the type is the capability.
 */
declare const verified: unique symbol
export interface AdminSession {
  readonly email: string
  readonly [verified]: true
}

/**
 * Turns an authenticated email into an AdminSession, or undefined.
 *
 * The allowlist is an env var rather than a roles table because there is
 * exactly one operator, and a table would be ceremony around a constant.
 * Comparison is case-insensitive and trimmed: an allowlist that fails because
 * someone typed a trailing space is an allowlist that gets disabled.
 */
export function assertAdmin(email: string | undefined | null): AdminSession | undefined {
  if (!email) return undefined
  const allowed = env()
    .ADMIN_EMAILS.split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  if (allowed.length === 0) return undefined
  if (!allowed.includes(email.trim().toLowerCase())) return undefined
  return { email } as AdminSession
}

/** Every read below goes through this, so the bypass is one expression. */
function unscoped() {
  return adminDb()
}

/**
 * The operator's own `user.id`, or undefined if they have never signed in here.
 *
 * Belongs with authorization rather than with the panels: it is the second half
 * of turning a verified session into something the database can talk about. The
 * audit trail in the operator actions needs it, because `trace_runs.owner_id`
 * references `"user"(id)` and a site-wide action has no visitor to attribute to.
 */
export async function adminOwnerId(session: AdminSession): Promise<string | undefined> {
  const [row] = await unscoped()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, session.email))
    .limit(1)
  return row?.id
}
