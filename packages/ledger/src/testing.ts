import type { OwnerId } from './owner'
import { deleteOwnerRows } from './repo/link'
import { ensureOwnerUser } from './repo/users'

/**
 * Puts one owner back to nothing: a principal that exists, owning no rows.
 *
 * Test helper, and the reason it exists is worth stating: owner-scoped tests
 * that seed in `beforeAll` accumulate rows across runs, because nothing else
 * clears them. A test that asserts "Alice has one transaction" then passes on
 * the first run and fails on the second, which reads as flakiness and is
 * actually state. Every owner-scoped suite starts by resetting its own owners.
 *
 * The `user` row comes first because `owner_id` references it: a suite that
 * invents an owner uuid has invented a principal, and the foreign key wants one
 * to exist. Setup and teardown are one call so no suite can do half of it.
 *
 * The deletion itself is `deleteOwnerRows`, which is the same table list
 * `repointOwner` uses and the same one the coverage test asserts against — a
 * second hand-written list here would be a second thing to forget to update.
 */
export async function resetOwner(owner: OwnerId): Promise<void> {
  await ensureOwnerUser(owner)
  await deleteOwnerRows(owner)
}

export async function resetOwners(...owners: OwnerId[]): Promise<void> {
  for (const owner of owners) await resetOwner(owner)
}
