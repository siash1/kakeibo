/**
 * The write gate's unit of decision.
 *
 * A suspended turn is one row and one answer. `runTurn` puts *every* write in
 * the suspending batch into `pending`, the provider requires every
 * `functionCall` in a turn to be answered together, and `takeSuspendedTurn`
 * deletes the row in the same statement that reads it. The batch cannot be
 * answered piecemeal, so a page offering one control per write offers a
 * granularity the loop cannot honour.
 *
 * It offered exactly that. Each write rendered its own slip with its own Allow
 * and Decline, and answering one posted a single decision; `runTurn` then
 * matched the rest by id, found them missing, and executed each as a decline
 * the visitor was never asked about. Their slips kept live buttons that could
 * only ever answer 410. These two functions are what the page uses instead:
 * group by the turn, decide the whole of it.
 */

export interface HasSuspendedTurn {
  id: string
  suspendedTurnId: string
}

export interface ConfirmGroup<T extends HasSuspendedTurn> {
  suspendedTurnId: string
  writes: T[]
}

/**
 * Groups writes by the turn they suspended, in first-seen order.
 *
 * Order matters twice over: the slips read down the page in the order the model
 * proposed them, and a second suspended turn later in the same conversation
 * must not merge into the first.
 */
export function groupBySuspendedTurn<T extends HasSuspendedTurn>(items: T[]): ConfirmGroup<T>[] {
  const groups: ConfirmGroup<T>[] = []
  const seen = new Map<string, ConfirmGroup<T>>()

  for (const item of items) {
    const existing = seen.get(item.suspendedTurnId)
    if (existing) {
      existing.writes.push(item)
      continue
    }
    const group: ConfirmGroup<T> = { suspendedTurnId: item.suspendedTurnId, writes: [item] }
    seen.set(item.suspendedTurnId, group)
    groups.push(group)
  }

  return groups
}

/**
 * One decision per write in the batch.
 *
 * The omission this replaces was silent, which is what made it dangerous: an id
 * the server cannot find in `decisions` is not an error, it is a decline.
 */
export function decisionsFor<T extends HasSuspendedTurn>(
  writes: T[],
  allowed: boolean,
): { id: string; allowed: boolean }[] {
  return writes.map((write) => ({ id: write.id, allowed }))
}
