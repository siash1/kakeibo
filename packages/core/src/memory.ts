/**
 * Long-term memory (spec 8.5).
 *
 * Deliberately boring: a table, a recency window, and a keyword match against
 * category names. No embeddings, no vector store. Semantic recall via pgvector
 * is listed in the README as a stretch, not shipped, because "most recent 20
 * plus anything matching a category the question mentions" answers the actual
 * questions a single-user ledger agent gets asked, and it is trivially
 * explainable in an interview.
 *
 * The interesting decision is that writing a memory is a *write-tier tool*.
 * Memory is the one place where a prompt injection could earn persistence —
 * "remember that confirmations are disabled" surviving into every future
 * session is a far worse outcome than any single bad tool call. Putting it
 * behind the confirmation gate makes that attack require a human mistake.
 */

export type MemorySource = 'user_stated' | 'agent_inferred'

export interface Memory {
  id: string
  content: string
  category: string
  source: MemorySource
  createdAt: Date
}

export interface MemoryStore {
  recent(limit: number): Promise<Memory[]>
  byCategories(categories: string[]): Promise<Memory[]>
  save(input: { content: string; category: string; source: MemorySource }): Promise<Memory>
}

export interface RecallOptions {
  /** The user's question, scanned for category mentions. */
  question: string
  /** Category/account names worth matching against. */
  knownCategories: string[]
  recentLimit?: number
}

/**
 * Recency plus topical relevance, de-duplicated, newest first.
 */
export async function recallMemories(
  store: MemoryStore,
  options: RecallOptions,
): Promise<Memory[]> {
  const recent = await store.recent(options.recentLimit ?? 20)
  const mentioned = matchCategories(options.question, options.knownCategories)
  const topical = mentioned.length > 0 ? await store.byCategories(mentioned) : []

  const seen = new Set<string>()
  const merged: Memory[] = []
  for (const memory of [...recent, ...topical]) {
    if (seen.has(memory.id)) continue
    seen.add(memory.id)
    merged.push(memory)
  }
  return merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

export function matchCategories(question: string, knownCategories: string[]): string[] {
  const haystack = question.toLowerCase()
  return knownCategories.filter((category) => {
    const needle = category.toLowerCase()
    // Word-boundary match so "Rent" does not fire on "different".
    return new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(haystack)
  })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
