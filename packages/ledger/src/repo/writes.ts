import type { Memory, MemorySource, MemoryStore } from '@kakeibo/core/memory'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { withOwner } from '../db'
import type { OwnerId } from '../owner'
import { accounts, budgets, importBatches, memories, rules } from '../schema'
import { requireAccount } from './accounts'

/** Write-side repositories: rules, budgets, memories, import batches. */

export interface RuleRow {
  id: string
  pattern: string
  category: string
  priority: number
}

export async function listRules(owner: OwnerId): Promise<RuleRow[]> {
  const rows = await withOwner(owner, (tx) =>
    tx.select().from(rules).where(eq(rules.ownerId, owner)).orderBy(rules.priority),
  )
  const accountIds = [...new Set(rows.map((r) => r.accountId))]
  const accountRows =
    accountIds.length > 0
      ? await withOwner(owner, (tx) =>
          tx
            .select()
            .from(accounts)
            .where(and(eq(accounts.ownerId, owner), inArray(accounts.id, accountIds))),
        )
      : []
  const names = new Map(accountRows.map((a) => [a.id, a.name]))
  return rows.map((row) => ({
    id: row.id,
    pattern: row.pattern,
    category: names.get(row.accountId) ?? '(unknown)',
    priority: row.priority,
  }))
}

export async function setCategoryRule(
  owner: OwnerId,
  input: {
    pattern: string
    category: string
    priority?: number
  },
): Promise<RuleRow> {
  const account = await requireAccount(owner, input.category)
  const [row] = await withOwner(owner, (tx) =>
    tx
      .insert(rules)
      .values({
        ownerId: owner,
        pattern: input.pattern,
        accountId: account.id,
        priority: input.priority ?? 100,
      })
      .returning(),
  )
  return { id: row!.id, pattern: row!.pattern, category: account.name, priority: row!.priority }
}

/**
 * Applies the rule set to a description, lowest priority number first.
 * Matching is a case-insensitive substring, not a regex: rules come from user
 * input via a tool, and a regex there is a denial-of-service waiting to happen.
 */
export function matchRule(description: string, ruleRows: RuleRow[]): RuleRow | undefined {
  const haystack = description.toLowerCase()
  return [...ruleRows]
    .sort((a, b) => a.priority - b.priority)
    .find((rule) => haystack.includes(rule.pattern.toLowerCase()))
}

export async function setBudget(
  owner: OwnerId,
  input: {
    category: string
    month: string
    amountMinor: number
  },
): Promise<{ id: string; category: string; month: string; amountMinor: number }> {
  const account = await requireAccount(owner, input.category)
  const [row] = await withOwner(owner, (tx) =>
    tx
      .insert(budgets)
      .values({
        ownerId: owner,
        accountId: account.id,
        month: input.month,
        amountMinor: input.amountMinor,
      })
      .onConflictDoUpdate({
        target: [budgets.accountId, budgets.month],
        set: { amountMinor: input.amountMinor },
      })
      .returning(),
  )
  return {
    id: row!.id,
    category: account.name,
    month: row!.month,
    amountMinor: Number(row!.amountMinor),
  }
}

export async function listBudgets(owner: OwnerId, month?: string) {
  const rows = await withOwner(owner, (tx) =>
    tx
      .select()
      .from(budgets)
      .where(
        month
          ? and(eq(budgets.ownerId, owner), eq(budgets.month, month))
          : eq(budgets.ownerId, owner),
      ),
  )
  return rows.map((r) => ({ ...r, amountMinor: Number(r.amountMinor) }))
}

export async function createImportBatch(
  owner: OwnerId,
  filename: string,
  rowCount: number,
): Promise<string> {
  const [row] = await withOwner(owner, (tx) =>
    tx.insert(importBatches).values({ ownerId: owner, filename, rowCount }).returning(),
  )
  return row!.id
}

/** Postgres-backed MemoryStore (spec 8.5). */
export class DbMemoryStore implements MemoryStore {
  // Owner is a constructor dependency, not a method parameter: MemoryStore is
  // a core interface and core must not learn about tenancy.
  constructor(private readonly owner: OwnerId) {}

  async recent(limit: number): Promise<Memory[]> {
    const rows = await withOwner(this.owner, (tx) =>
      tx
        .select()
        .from(memories)
        .where(eq(memories.ownerId, this.owner))
        .orderBy(desc(memories.createdAt))
        .limit(limit),
    )
    return rows.map(toMemory)
  }

  async byCategories(categories: string[]): Promise<Memory[]> {
    if (categories.length === 0) return []
    const rows = await withOwner(this.owner, (tx) =>
      tx
        .select()
        .from(memories)
        .where(and(eq(memories.ownerId, this.owner), inArray(memories.category, categories)))
        .orderBy(desc(memories.createdAt)),
    )
    return rows.map(toMemory)
  }

  async save(input: { content: string; category: string; source: MemorySource }): Promise<Memory> {
    // Same content in the same category twice is a no-op, so a model that
    // re-saves a fact it already knows does not fill the table with copies.
    const existing = await withOwner(this.owner, (tx) =>
      tx
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.ownerId, this.owner),
            eq(memories.content, input.content),
            eq(memories.category, input.category),
          ),
        )
        .limit(1),
    )
    if (existing[0]) return toMemory(existing[0])

    const [row] = await withOwner(this.owner, (tx) =>
      tx
        .insert(memories)
        .values({ ...input, ownerId: this.owner })
        .returning(),
    )
    return toMemory(row!)
  }
}

function toMemory(row: typeof memories.$inferSelect): Memory {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    source: row.source,
    createdAt: row.createdAt,
  }
}
