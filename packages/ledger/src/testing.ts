import { eq } from 'drizzle-orm'
import { adminDb } from './db'
import type { OwnerId } from './owner'
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
 */
export async function resetOwner(owner: OwnerId): Promise<void> {
  const db = adminDb()
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
