import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { normalizeCategory, SEED_ACCOUNTS } from '../categories'
import { withOwner } from '../db'
import type { OwnerId } from '../owner'
import { type Account, accounts, postings } from '../schema'

export async function listAccounts(owner: OwnerId): Promise<Account[]> {
  return withOwner(owner, (tx) =>
    tx
      .select()
      .from(accounts)
      .where(eq(accounts.ownerId, owner))
      .orderBy(asc(accounts.type), asc(accounts.name)),
  )
}

export async function accountByName(owner: OwnerId, name: string): Promise<Account | undefined> {
  const canonical = normalizeCategory(name) ?? name
  const rows = await withOwner(owner, (tx) =>
    tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.ownerId, owner), eq(accounts.name, canonical)))
      .limit(1),
  )
  return rows[0]
}

/**
 * Resolves a category name the model supplied, with a helpful error rather than
 * a silent miss. The model sees the valid list in the system prompt, but a typo
 * or a plural is common enough that the failure message should teach it.
 */
export async function requireAccount(owner: OwnerId, name: string): Promise<Account> {
  const account = await accountByName(owner, name)
  if (account) return account
  const known = (await listAccounts(owner)).map((a) => a.name).join(', ')
  throw new Error(`No account named "${name}". Known accounts: ${known}`)
}

export async function accountsByIds(owner: OwnerId, ids: string[]): Promise<Map<string, Account>> {
  if (ids.length === 0) return new Map()
  const rows = await withOwner(owner, (tx) =>
    tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.ownerId, owner), inArray(accounts.id, ids))),
  )
  return new Map(rows.map((row) => [row.id, row]))
}

export interface AccountBalance extends Account {
  balanceMinor: number
  postingCount: number
}

/**
 * Balances are the signed sum of postings per account. For an expense account
 * that reads as "total spent"; for Checking it is the running balance.
 */
export async function accountBalances(owner: OwnerId): Promise<AccountBalance[]> {
  const rows = await withOwner(owner, (tx) =>
    tx
      .select({
        id: accounts.id,
        ownerId: accounts.ownerId,
        name: accounts.name,
        type: accounts.type,
        currency: accounts.currency,
        createdAt: accounts.createdAt,
        balanceMinor: sql<number>`coalesce(sum(${postings.amountMinor}), 0)::bigint`,
        postingCount: sql<number>`count(${postings.id})::int`,
      })
      .from(accounts)
      // The join is owner-scoped too. Joining on account_id alone would be
      // correct only because account ids are unique — relying on that makes
      // the isolation accidental rather than stated.
      .leftJoin(postings, and(eq(postings.accountId, accounts.id), eq(postings.ownerId, owner)))
      .where(eq(accounts.ownerId, owner))
      .groupBy(accounts.id)
      .orderBy(asc(accounts.type), asc(accounts.name)),
  )

  return rows.map((row) => ({
    ...row,
    balanceMinor: Number(row.balanceMinor),
    postingCount: Number(row.postingCount),
  }))
}

/** Idempotent: seeding twice must not duplicate an owner's chart of accounts. */
export async function ensureSeedAccounts(owner: OwnerId): Promise<void> {
  await withOwner(owner, (tx) =>
    tx
      .insert(accounts)
      .values(SEED_ACCOUNTS.map((a) => ({ ownerId: owner, name: a.name, type: a.type })))
      .onConflictDoNothing({ target: [accounts.ownerId, accounts.name] }),
  )
}
