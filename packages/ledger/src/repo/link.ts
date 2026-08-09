import { eq, getTableName } from 'drizzle-orm'
import { adminDb, type Tx } from '../db'
import {
  accounts,
  budgets,
  conversationMessages,
  conversations,
  importBatches,
  memories,
  postings,
  rules,
  suspendedTurns,
  traceEvents,
  traceRuns,
  transactions,
} from '../schema'

/**
 * Every owner-scoped table, children before parents.
 *
 * The order is only load-bearing on the delete path — nothing here cascades on
 * owner_id between ledger tables, but postings reference transactions and
 * trace_events reference trace_runs, so deleting parents first would fail.
 *
 * A table missing from this list is a ledger fragment that outlives its owner:
 * repointing leaves it behind, and the user cascade then deletes it out from
 * under the account that should have inherited it. `link.test.ts` derives the
 * expected set from the schema so that adding a table cannot quietly skip it.
 */
const OWNED = [
  traceEvents,
  traceRuns,
  suspendedTurns,
  conversationMessages,
  conversations,
  postings,
  transactions,
  budgets,
  rules,
  memories,
  importBatches,
  accounts,
] as const

/** The same list as plain names, for the coverage assertion in the tests. */
export const OWNER_SCOPED_TABLES: readonly string[] = OWNED.map((table) => getTableName(table))

export interface RepointResult {
  /**
   * `moved` — the ledger changed hands.
   * `discarded` — the new owner already had one, so the anonymous ledger was
   * deleted rather than merged. See the note on the collision below.
   */
  outcome: 'moved' | 'discarded'
  /** Rows affected, keyed by table name. */
  rows: Record<string, number>
}

/**
 * Hands one owner's entire ledger to another, in one transaction.
 *
 * Called from Better Auth's `onLinkAccount` when an anonymous visitor signs in.
 * The plugin deletes the anonymous user the moment that hook returns, so this
 * cannot be lazy or partial: a row left pointing at the old owner is swept away
 * by the cascade a few milliseconds later.
 *
 * **When the new owner already has a ledger, the old one is discarded rather
 * than merged.** Every ledger here is a clone of the same synthetic corpus, so
 * both sides have an account named "Groceries" — and `accounts` is unique on
 * `(owner_id, name)`, which makes a repoint a constraint violation rather than
 * a merge. Merging properly would mean mapping accounts by name and would
 * double every figure in every report, since both ledgers hold the same 352
 * transactions. The account a visitor signs in to is the ledger they came back
 * for; the anonymous one was a demo.
 *
 * `adminDb` because it spans two owners by definition, which is exactly what
 * the row-level security policies forbid.
 */
export async function repointOwner(from: string, to: string): Promise<RepointResult> {
  if (from === to) return { outcome: 'moved', rows: {} }

  return adminDb().transaction(async (tx) => {
    const rows: Record<string, number> = {}

    const [existing] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.ownerId, to))
      .limit(1)

    // `accounts` is the marker for "has a ledger": every other owned table
    // hangs off one, and ensureSeedAccounts is the first thing any ledger gets.
    const outcome = existing ? 'discarded' : 'moved'

    for (const table of OWNED) {
      rows[getTableName(table)] = await (outcome === 'moved'
        ? moveRows(tx, table, from, to)
        : dropRows(tx, table, from))
    }

    return { outcome, rows }
  })
}

/**
 * Deletes every row an owner has, leaving the owner themselves in place.
 *
 * The "delete my ledger but keep my account" action, and the test helpers'
 * teardown. It shares `OWNED` with `repointOwner` on purpose: two hand-written
 * lists of owner-scoped tables would drift, and the one that drifts is the one
 * that leaves rows behind.
 */
export async function deleteOwnerRows(owner: string): Promise<Record<string, number>> {
  return adminDb().transaction(async (tx) => {
    const rows: Record<string, number> = {}
    for (const table of OWNED) rows[getTableName(table)] = await dropRows(tx, table, owner)
    return rows
  })
}

/**
 * The one narrow cast in this module.
 *
 * Drizzle types `update(...).set(...)` from each table's own insert type, so a
 * loop over nine different tables has no single type that satisfies all of
 * them — even though every one of them has exactly the `owner_id uuid` column
 * being written. Casting the table is the smallest lie available; casting the
 * value would silence a real mismatch.
 */
type OwnedTable = (typeof OWNED)[number]

async function moveRows(tx: Tx, table: OwnedTable, from: string, to: string): Promise<number> {
  const updated = await tx
    .update(table as typeof accounts)
    .set({ ownerId: to })
    .where(eq(table.ownerId, from))
    .returning({ id: table.id })
  return updated.length
}

async function dropRows(tx: Tx, table: OwnedTable, from: string): Promise<number> {
  const deleted = await tx
    .delete(table as typeof accounts)
    .where(eq(table.ownerId, from))
    .returning({ id: table.id })
  return deleted.length
}
