import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm'
import { UNCATEGORIZED } from '../categories'
import { withOwner } from '../db'
import type { OwnerId } from '../owner'
import { sumMinor } from '../money'
import { accounts, postings, type Transaction, transactions } from '../schema'
import { requireAccount } from './accounts'

/**
 * The single insert path for money (spec 7).
 *
 * Every transaction goes through `createTransaction`, and `createTransaction`
 * refuses anything whose postings do not sum to zero. That is the whole
 * enforcement mechanism for double entry — no triggers, no constraint that
 * exists only in the database. One code path, one rule, one invariant test that
 * can actually reach it.
 */

export interface PostingInput {
  accountId: string
  amountMinor: number
  currency?: string
}

export interface CreateTransactionInput {
  /** Explicit primary key. Only the seed generator sets this (see ids.ts). */
  id?: string
  date: string
  description: string
  rawDescription?: string
  importBatchId?: string | null
  postings: PostingInput[]
}

export class UnbalancedTransactionError extends Error {
  constructor(readonly delta: number) {
    super(
      `Postings do not balance: they sum to ${delta} minor units, not 0. ` +
        'Every transaction must have equal debits and credits.',
    )
    this.name = 'UnbalancedTransactionError'
  }
}

export async function createTransaction(
  owner: OwnerId,
  input: CreateTransactionInput,
): Promise<Transaction> {
  assertBalanced(input.postings)

  return withOwner(owner, async (tx) => {
    const [row] = await tx
      .insert(transactions)
      .values({
        ...(input.id ? { id: input.id } : {}),
        ownerId: owner,
        date: input.date,
        description: input.description,
        rawDescription: input.rawDescription ?? input.description,
        importBatchId: input.importBatchId ?? null,
      })
      .returning()

    await tx.insert(postings).values(
      input.postings.map((p) => ({
        ownerId: owner,
        transactionId: row!.id,
        accountId: p.accountId,
        amountMinor: p.amountMinor,
        currency: p.currency ?? 'INR',
      })),
    )

    return row!
  })
}

/** Bulk path for imports: one DB transaction for the whole batch. */
export async function createTransactions(
  owner: OwnerId,
  inputs: CreateTransactionInput[],
): Promise<number> {
  for (const input of inputs) assertBalanced(input.postings)
  if (inputs.length === 0) return 0

  return withOwner(owner, async (tx) => {
    const rows = await tx
      .insert(transactions)
      .values(
        inputs.map((input) => ({
          ...(input.id ? { id: input.id } : {}),
          ownerId: owner,
          date: input.date,
          description: input.description,
          rawDescription: input.rawDescription ?? input.description,
          importBatchId: input.importBatchId ?? null,
        })),
      )
      .returning({ id: transactions.id })

    const postingValues = inputs.flatMap((input, index) =>
      input.postings.map((p) => ({
        ownerId: owner,
        transactionId: rows[index]!.id,
        accountId: p.accountId,
        amountMinor: p.amountMinor,
        currency: p.currency ?? 'INR',
      })),
    )
    await tx.insert(postings).values(postingValues)
    return rows.length
  })
}

export function assertBalanced(inputs: PostingInput[]): void {
  if (inputs.length < 2) {
    throw new UnbalancedTransactionError(sumMinor(inputs.map((p) => p.amountMinor)))
  }
  const delta = sumMinor(inputs.map((p) => p.amountMinor))
  if (delta !== 0) throw new UnbalancedTransactionError(delta)
}

export interface TransactionWithPostings {
  id: string
  date: string
  description: string
  rawDescription: string
  postings: { account: string; accountType: string; amountMinor: number; currency: string }[]
}

export interface SearchFilters {
  query?: string
  account?: string
  from?: string
  to?: string
  minMinor?: number
  maxMinor?: number
  limit?: number
}

export async function searchTransactions(
  owner: OwnerId,
  filters: SearchFilters,
): Promise<TransactionWithPostings[]> {
  // Owner is the FIRST condition, so any scan is bounded by tenant before a
  // single one of the user's own filters applies.
  const conditions = [eq(transactions.ownerId, owner)]

  if (filters.query) {
    const pattern = `%${filters.query}%`
    conditions.push(
      or(ilike(transactions.description, pattern), ilike(transactions.rawDescription, pattern)),
    )
  }
  if (filters.from) conditions.push(gte(transactions.date, filters.from))
  if (filters.to) conditions.push(lte(transactions.date, filters.to))

  if (filters.account) {
    const account = await requireAccount(owner, filters.account)
    conditions.push(
      sql`exists (select 1 from ${postings} p where p.transaction_id = ${transactions.id} and p.owner_id = ${owner} and p.account_id = ${account.id})`,
    )
  }

  // Amount filters compare the magnitude of the transaction, which for a
  // two-posting entry is the absolute value of either side.
  if (filters.minMinor !== undefined) {
    conditions.push(
      sql`exists (select 1 from ${postings} p where p.transaction_id = ${transactions.id} and p.owner_id = ${owner} and abs(p.amount_minor) >= ${filters.minMinor})`,
    )
  }
  if (filters.maxMinor !== undefined) {
    conditions.push(
      sql`not exists (select 1 from ${postings} p where p.transaction_id = ${transactions.id} and p.owner_id = ${owner} and abs(p.amount_minor) > ${filters.maxMinor})`,
    )
  }

  const rows = await withOwner(owner, (tx) =>
    tx
      .select()
      .from(transactions)
      .where(and(...conditions))
    // The id tiebreaker is load-bearing: a bulk import gives every row the same
    // created_at, so without it Postgres may return same-date rows in any order.
    // That makes tool output non-reproducible, which breaks replay fixtures and
    // eval oracles alike.
      .orderBy(desc(transactions.date), desc(transactions.createdAt), asc(transactions.id))
      .limit(filters.limit ?? 20),
  )

  return hydratePostings(owner, rows)
}

export async function transactionsByIds(
  owner: OwnerId,
  ids: string[],
): Promise<TransactionWithPostings[]> {
  if (ids.length === 0) return []
  const rows = await withOwner(owner, (tx) =>
    tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.ownerId, owner), inArray(transactions.id, ids)))
      .orderBy(asc(transactions.date)),
  )
  return hydratePostings(owner, rows)
}

// Takes the owner explicitly rather than inferring it from the rows it was
// handed — inferring would trust the caller to have scoped already.
async function hydratePostings(
  owner: OwnerId,
  rows: Transaction[],
): Promise<TransactionWithPostings[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const postingRows = await withOwner(owner, (tx) =>
    tx
      .select({
      transactionId: postings.transactionId,
      amountMinor: postings.amountMinor,
      currency: postings.currency,
      account: accounts.name,
      accountType: accounts.type,
    })
      .from(postings)
      .innerJoin(accounts, and(eq(accounts.id, postings.accountId), eq(accounts.ownerId, owner)))
      .where(and(eq(postings.ownerId, owner), inArray(postings.transactionId, ids))),
  )

  const byTransaction = new Map<string, TransactionWithPostings['postings']>()
  for (const row of postingRows) {
    const list = byTransaction.get(row.transactionId) ?? []
    list.push({
      account: row.account,
      accountType: row.accountType,
      amountMinor: Number(row.amountMinor),
      currency: row.currency,
    })
    byTransaction.set(row.transactionId, list)
  }

  return rows.map((row) => ({
    id: row.id,
    date: row.date,
    description: row.description,
    rawDescription: row.rawDescription,
    postings: byTransaction.get(row.id) ?? [],
  }))
}

export interface CategorizeResult {
  updated: number
  skipped: { id: string; reason: string }[]
}

/**
 * Categorising repoints a posting; it never moves money (spec 7).
 *
 * The transaction already balances. Changing which expense account one side
 * points at leaves the sum at zero by construction, so there is no window in
 * which the ledger is inconsistent — which is exactly why this is an UPDATE and
 * not a delete-and-reinsert.
 */
export async function categorizeTransactions(
  owner: OwnerId,
  transactionIds: string[],
  categoryName: string,
): Promise<CategorizeResult> {
  const target = await requireAccount(owner, categoryName)
  if (target.type !== 'expense' && target.type !== 'income') {
    throw new Error(
      `"${target.name}" is a ${target.type} account. Transactions can only be categorised into expense or income accounts.`,
    )
  }
  if (transactionIds.length === 0) return { updated: 0, skipped: [] }

  const candidates = await withOwner(owner, (tx) =>
    tx
      .select({
      postingId: postings.id,
      transactionId: postings.transactionId,
      accountId: postings.accountId,
      accountName: accounts.name,
      accountType: accounts.type,
    })
      .from(postings)
      .innerJoin(accounts, and(eq(accounts.id, postings.accountId), eq(accounts.ownerId, owner)))
      .where(and(eq(postings.ownerId, owner), inArray(postings.transactionId, transactionIds))),
  )

  const byTransaction = new Map<string, typeof candidates>()
  for (const row of candidates) {
    const list = byTransaction.get(row.transactionId) ?? []
    list.push(row)
    byTransaction.set(row.transactionId, list)
  }

  const toUpdate: string[] = []
  const skipped: { id: string; reason: string }[] = []

  for (const id of transactionIds) {
    const rows = byTransaction.get(id)
    if (!rows || rows.length === 0) {
      skipped.push({ id, reason: 'no such transaction' })
      continue
    }
    // Prefer the Uncategorized side; otherwise the single expense/income side.
    const uncategorized = rows.find((r) => r.accountName === UNCATEGORIZED)
    const classifiable = rows.filter(
      (r) => r.accountType === 'expense' || r.accountType === 'income',
    )
    const chosen = uncategorized ?? (classifiable.length === 1 ? classifiable[0] : undefined)

    if (!chosen) {
      skipped.push({
        id,
        reason:
          classifiable.length === 0
            ? 'no expense or income posting to recategorise'
            : 'ambiguous: more than one expense/income posting',
      })
      continue
    }
    if (chosen.accountId === target.id) {
      skipped.push({ id, reason: `already categorised as ${target.name}` })
      continue
    }
    toUpdate.push(chosen.postingId)
  }

  if (toUpdate.length > 0) {
    await withOwner(owner, (tx) =>
      tx
        .update(postings)
        .set({ accountId: target.id })
        .where(and(eq(postings.ownerId, owner), inArray(postings.id, toUpdate))),
    )
  }

  return { updated: toUpdate.length, skipped }
}

/** Postings that sum to something other than zero. Should always be empty. */
export async function findUnbalancedTransactions(
  owner: OwnerId,
): Promise<{ id: string; delta: number }[]> {
  const rows = await withOwner(owner, (tx) =>
    tx
      .select({
      id: postings.transactionId,
      delta: sql<number>`sum(${postings.amountMinor})::bigint`,
    })
      .from(postings)
      .where(eq(postings.ownerId, owner))
      .groupBy(postings.transactionId)
      .having(sql`sum(${postings.amountMinor}) <> 0`),
  )
  return rows.map((r) => ({ id: r.id, delta: Number(r.delta) }))
}
