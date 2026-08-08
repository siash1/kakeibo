import { asc, eq, inArray, sql } from 'drizzle-orm'
import { normalizeCategory, SEED_ACCOUNTS } from '../categories'
import { getDb } from '../db'
import { type Account, accounts, postings } from '../schema'

export async function listAccounts(): Promise<Account[]> {
  return getDb().select().from(accounts).orderBy(asc(accounts.type), asc(accounts.name))
}

export async function accountByName(name: string): Promise<Account | undefined> {
  const canonical = normalizeCategory(name) ?? name
  const rows = await getDb().select().from(accounts).where(eq(accounts.name, canonical)).limit(1)
  return rows[0]
}

/**
 * Resolves a category name the model supplied, with a helpful error rather than
 * a silent miss. The model sees the valid list in the system prompt, but a typo
 * or a plural is common enough that the failure message should teach it.
 */
export async function requireAccount(name: string): Promise<Account> {
  const account = await accountByName(name)
  if (account) return account
  const known = (await listAccounts()).map((a) => a.name).join(', ')
  throw new Error(`No account named "${name}". Known accounts: ${known}`)
}

export async function accountsByIds(ids: string[]): Promise<Map<string, Account>> {
  if (ids.length === 0) return new Map()
  const rows = await getDb().select().from(accounts).where(inArray(accounts.id, ids))
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
export async function accountBalances(): Promise<AccountBalance[]> {
  const rows = await getDb()
    .select({
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      currency: accounts.currency,
      createdAt: accounts.createdAt,
      balanceMinor: sql<number>`coalesce(sum(${postings.amountMinor}), 0)::bigint`,
      postingCount: sql<number>`count(${postings.id})::int`,
    })
    .from(accounts)
    .leftJoin(postings, eq(postings.accountId, accounts.id))
    .groupBy(accounts.id)
    .orderBy(asc(accounts.type), asc(accounts.name))

  return rows.map((row) => ({
    ...row,
    balanceMinor: Number(row.balanceMinor),
    postingCount: Number(row.postingCount),
  }))
}

/** Idempotent: seeding twice must not duplicate the chart of accounts. */
export async function ensureSeedAccounts(): Promise<void> {
  await getDb()
    .insert(accounts)
    .values(SEED_ACCOUNTS.map((a) => ({ name: a.name, type: a.type })))
    .onConflictDoNothing({ target: accounts.name })
}
