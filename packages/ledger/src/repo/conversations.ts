import type { SuspendedState } from '@kakeibo/core/suspend'
import type { CanonicalMessage } from '@kakeibo/core/types'
import { and, desc, eq, sql } from 'drizzle-orm'
import { withOwner } from '../db'
import type { OwnerId } from '../owner'
import { conversationMessages, conversations, suspendedTurns } from '../schema'

/**
 * Conversation and suspended-turn persistence (spec §3.3, §6).
 *
 * This is what replaces the module-level Map the web app used to keep history
 * in. That Map is per-process, and on serverless the next request is a
 * different process — so a conversation lasted exactly as long as one function
 * invocation, and the confirm gate, which awaited a promise across two
 * requests, could not work at all.
 */

/** An abandoned confirmation card must not still be answerable tomorrow. */
const SUSPENDED_TTL_MS = 60 * 60_000

export async function createConversation(
  owner: OwnerId,
  title?: string,
): Promise<{ id: string; title: string | null }> {
  const [row] = await withOwner(owner, (tx) =>
    tx
      .insert(conversations)
      .values({ ownerId: owner, title: title ?? null })
      .returning({ id: conversations.id, title: conversations.title }),
  )
  return row!
}

/** The owner's most recently touched thread, or undefined if they have none. */
export async function latestConversation(
  owner: OwnerId,
): Promise<{ id: string; title: string | null } | undefined> {
  const [row] = await withOwner(owner, (tx) =>
    tx
      .select({ id: conversations.id, title: conversations.title })
      .from(conversations)
      .where(eq(conversations.ownerId, owner))
      .orderBy(desc(conversations.updatedAt))
      .limit(1),
  )
  return row
}

/**
 * Appends messages to the end of a thread.
 *
 * The sequence continues from what is stored, computed inside the same
 * transaction as the insert. Two writers racing on one conversation collide on
 * `conversation_messages_conversation_seq_key` rather than quietly interleaving
 * into a history that the provider will reject on the next request.
 */
export async function appendMessages(
  owner: OwnerId,
  conversationId: string,
  messages: CanonicalMessage[],
): Promise<void> {
  if (messages.length === 0) return

  await withOwner(owner, async (tx) => {
    const [row] = await tx
      .select({ maxSeq: sql<number>`coalesce(max(${conversationMessages.seq}), -1)::int` })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.ownerId, owner),
          eq(conversationMessages.conversationId, conversationId),
        ),
      )
    let seq = Number(row?.maxSeq ?? -1) + 1

    await tx.insert(conversationMessages).values(
      messages.map((message) => ({
        ownerId: owner,
        conversationId,
        seq: seq++,
        // Verbatim. No mapping, no field selection: `providerMeta` carries
        // Gemini's opaque thoughtSignature and dropping it is a hard 400 on
        // the next request, on tool turns only.
        message: message as unknown as object,
      })),
    )

    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(and(eq(conversations.ownerId, owner), eq(conversations.id, conversationId)))
  })
}

export async function loadHistory(
  owner: OwnerId,
  conversationId: string,
): Promise<CanonicalMessage[]> {
  const rows = await withOwner(owner, (tx) =>
    tx
      .select({ message: conversationMessages.message })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.ownerId, owner),
          eq(conversationMessages.conversationId, conversationId),
        ),
      )
      .orderBy(conversationMessages.seq),
  )
  return rows.map((row) => row.message as CanonicalMessage)
}

export async function saveSuspendedTurn(
  owner: OwnerId,
  conversationId: string,
  state: SuspendedState,
  options: { ttlMs?: number } = {},
): Promise<string> {
  const [row] = await withOwner(owner, (tx) =>
    tx
      .insert(suspendedTurns)
      .values({
        ownerId: owner,
        conversationId,
        runId: state.runId,
        history: state.history as unknown as object,
        completedResults: state.completedResults as unknown as object,
        pending: state.pending as unknown as object,
        usage: state.usage as unknown as object,
        costUsdEst: state.costUsdEst.toFixed(6),
        iterations: state.iterations,
        expiresAt: new Date(Date.now() + (options.ttlMs ?? SUSPENDED_TTL_MS)),
      })
      .returning({ id: suspendedTurns.id }),
  )
  return row!.id
}

/**
 * Reads a suspended turn and deletes it in the same statement.
 *
 * Delete-as-you-read is the whole point: a decision that could be replayed is a
 * write that could be run twice, and the tools this gate protects are the ones
 * that change the ledger. An expired row is deleted too and reported as absent,
 * so an abandoned card cannot be answered an hour later.
 */
export async function takeSuspendedTurn(
  owner: OwnerId,
  id: string,
): Promise<{ conversationId: string; state: SuspendedState } | undefined> {
  const [row] = await withOwner(owner, (tx) =>
    tx
      .delete(suspendedTurns)
      .where(and(eq(suspendedTurns.ownerId, owner), eq(suspendedTurns.id, id)))
      .returning(),
  )
  if (!row) return undefined
  if (row.expiresAt.getTime() <= Date.now()) return undefined

  return {
    conversationId: row.conversationId,
    state: {
      runId: row.runId,
      history: row.history as CanonicalMessage[],
      completedResults: row.completedResults as SuspendedState['completedResults'],
      pending: row.pending as SuspendedState['pending'],
      usage: row.usage as SuspendedState['usage'],
      costUsdEst: Number(row.costUsdEst),
      iterations: row.iterations,
    },
  }
}
