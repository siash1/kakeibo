import { eq } from 'drizzle-orm'
import { adminDb } from './db'
import type { OwnerId } from './owner'
import { ensureOwnerUser } from './repo/users'
import {
  accounts,
  budgets,
  importBatches,
  memories,
  postings,
  rules,
  traceEvents,
  traceRuns,
  transactions,
} from './schema'

/**
 * Deletes everything belonging to one owner.
 *
 * Test helper, and the reason it exists is worth stating: owner-scoped tests
 * that seed in `beforeAll` accumulate rows across runs, because nothing else
 * clears them. A test that asserts "Alice has one transaction" then passes on
 * the first run and fails on the second, which reads as flakiness and is
 * actually state. Every owner-scoped suite starts by resetting its own owners.
 *
 * Uses `adminDb()` rather than `withOwner()` deliberately: this is teardown,
 * and it should work regardless of whether the RLS policies are in place yet.
 * Order matters — children before parents, since owner_id carries no cascade of
 * its own.
 *
 * It also creates the owner's `user` row, because `owner_id` references it: a
 * suite that invents an owner uuid has invented a principal, and the foreign
 * key wants one to exist. Setup and teardown are one call so that no suite can
 * do half of it.
 */
export async function resetOwner(owner: OwnerId): Promise<void> {
  const db = adminDb()
  await ensureOwnerUser(owner)
  await db.delete(traceEvents).where(eq(traceEvents.ownerId, owner))
  await db.delete(traceRuns).where(eq(traceRuns.ownerId, owner))
  await db.delete(postings).where(eq(postings.ownerId, owner))
  await db.delete(transactions).where(eq(transactions.ownerId, owner))
  await db.delete(budgets).where(eq(budgets.ownerId, owner))
  await db.delete(rules).where(eq(rules.ownerId, owner))
  await db.delete(memories).where(eq(memories.ownerId, owner))
  await db.delete(importBatches).where(eq(importBatches.ownerId, owner))
  await db.delete(accounts).where(eq(accounts.ownerId, owner))
}

export async function resetOwners(...owners: OwnerId[]): Promise<void> {
  for (const owner of owners) await resetOwner(owner)
}
