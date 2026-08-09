import { eq, sql } from 'drizzle-orm'
import { user } from '../auth-schema'
import { adminDb } from '../db'
import type { OwnerId } from '../owner'

/**
 * Creates the `user` row a local owner id needs in order to own ledger rows.
 *
 * `owner_id` references `user(id)`, so every surface that writes to the ledger
 * without going through Better Auth — `pnpm db:seed`, the eval harness, the
 * test helpers, the CLI, the MCP server — needs its fixed owner to exist as a
 * principal first. In production this never runs: Better Auth creates the row
 * on the visitor's first request.
 *
 * `adminDb` because `user` is the principal table, deliberately outside
 * row-level security, and because the app role has no privileges on it at all
 * (see the migration that revokes them).
 */
export async function ensureOwnerUser(
  owner: OwnerId,
  info: { name?: string; email?: string } = {},
): Promise<void> {
  await adminDb()
    .insert(user)
    .values({
      id: owner,
      name: info.name ?? 'kakeibo local',
      // Unique, and derived from the id so two owners can never collide. The
      // .local suffix is reserved for exactly this and can never be delivered
      // to, which is the point: nothing should ever mail a synthetic owner.
      email: info.email ?? `${owner}@kakeibo.local`,
      emailVerified: false,
    })
    .onConflictDoNothing({ target: user.id })
}

/**
 * Deletes a user, and with them every row they own.
 *
 * The cascade on `owner_id` is what makes this total; there is deliberately no
 * per-table delete list here to fall out of date.
 */
export async function deleteUser(id: string): Promise<boolean> {
  const rows = await adminDb().delete(user).where(eq(user.id, id)).returning({ id: user.id })
  return rows.length > 0
}

/** Does a principal exist for this id? Used by tests and the reaper's assertions. */
export async function userExists(id: string): Promise<boolean> {
  const rows = await adminDb()
    .select({ one: sql<number>`1` })
    .from(user)
    .where(eq(user.id, id))
    .limit(1)
  return rows.length > 0
}
