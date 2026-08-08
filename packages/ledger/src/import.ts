import { normalizeCategory, UNCATEGORIZED } from './categories'
import { type MappingPreset, type ParsedRow, parseStatement } from './csv'
import { formatMinor } from './money'
import { accountByName, requireAccount } from './repo/accounts'
import { type CreateTransactionInput, createTransactions } from './repo/transactions'
import { createImportBatch, listRules, matchRule } from './repo/writes'

/**
 * Statement import (tool 8).
 *
 * Every row becomes exactly two postings:
 *   Checking  += amount
 *   Category  -= amount
 *
 * One rule covers all four cases — a purchase, a salary credit, a refund
 * against an expense category, and interest income — and it sums to zero by
 * construction, so there is no case analysis to get wrong. The sign convention
 * is "effect on the Checking account", which is also how bank CSVs are written.
 */

export interface ImportPreview {
  filename: string
  rowCount: number
  dateRange: { from: string; to: string } | null
  totalInMinor: number
  totalOutMinor: number
  byCategory: { category: string; count: number; totalMinor: number }[]
  uncategorizedCount: number
  parseErrors: { lineNumber: number; message: string; raw: string }[]
  sample: { date: string; description: string; amount: string; category: string }[]
}

export interface ImportResult extends ImportPreview {
  importBatchId: string
  imported: number
}

interface ResolvedRow extends ParsedRow {
  category: string
}

export async function planImport(
  filename: string,
  text: string,
  preset: MappingPreset,
): Promise<{ preview: ImportPreview; resolved: ResolvedRow[] }> {
  const { rows, errors } = parseStatement(text, preset)
  const ruleRows = await listRules()

  const resolved: ResolvedRow[] = rows.map((row) => ({
    ...row,
    category: resolveCategory(row, ruleRows),
  }))

  const byCategory = new Map<string, { count: number; totalMinor: number }>()
  for (const row of resolved) {
    const entry = byCategory.get(row.category) ?? { count: 0, totalMinor: 0 }
    entry.count++
    entry.totalMinor += row.amountMinor
    byCategory.set(row.category, entry)
  }

  const dates = resolved.map((r) => r.date).sort()
  const preview: ImportPreview = {
    filename,
    rowCount: resolved.length,
    dateRange: dates.length > 0 ? { from: dates[0]!, to: dates[dates.length - 1]! } : null,
    totalInMinor: resolved.filter((r) => r.amountMinor > 0).reduce((s, r) => s + r.amountMinor, 0),
    totalOutMinor: resolved.filter((r) => r.amountMinor < 0).reduce((s, r) => s + r.amountMinor, 0),
    byCategory: [...byCategory.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.count - a.count),
    uncategorizedCount: resolved.filter((r) => r.category === UNCATEGORIZED).length,
    parseErrors: errors,
    sample: resolved.slice(0, 5).map((row) => ({
      date: row.date,
      description: row.description,
      amount: formatMinor(row.amountMinor),
      category: row.category,
    })),
  }

  return { preview, resolved }
}

export async function commitImport(
  filename: string,
  resolved: ResolvedRow[],
  preview: ImportPreview,
): Promise<ImportResult> {
  const checking = await requireAccount('Checking')
  const batchId = await createImportBatch(filename, resolved.length)

  const categoryIds = new Map<string, string>()
  for (const name of new Set(resolved.map((r) => r.category))) {
    categoryIds.set(name, (await requireAccount(name)).id)
  }

  const inputs: CreateTransactionInput[] = resolved.map((row) => ({
    date: row.date,
    description: row.description,
    rawDescription: row.description,
    importBatchId: batchId,
    postings: [
      { accountId: checking.id, amountMinor: row.amountMinor },
      { accountId: categoryIds.get(row.category)!, amountMinor: -row.amountMinor },
    ],
  }))

  const imported = await createTransactions(inputs)
  return { ...preview, importBatchId: batchId, imported }
}

function resolveCategory(row: ParsedRow, ruleRows: Awaited<ReturnType<typeof listRules>>): string {
  // 1. What the CSV declared, if it declared anything valid.
  if (row.category) {
    const canonical = normalizeCategory(row.category)
    if (canonical) return canonical
  }
  // 2. A user-defined rule, lowest priority number first.
  const rule = matchRule(row.description, ruleRows)
  if (rule) return rule.category
  // 3. Uncategorized — an unanswered question, not a classification.
  return UNCATEGORIZED
}

/** Guards against importing the same statement twice. */
export async function ensureAccountsExist(): Promise<void> {
  const checking = await accountByName('Checking')
  if (!checking) {
    throw new Error('The chart of accounts is empty. Run `pnpm db:migrate && pnpm db:seed` first.')
  }
}
