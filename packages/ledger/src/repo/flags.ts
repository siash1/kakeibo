import { eq } from 'drizzle-orm'
import { adminDb } from '../db'
import { operatorFlags } from '../schema'

/**
 * Site-wide operator switches (spec §9.4).
 *
 * Read on every chat request, which is why this is its own tiny module rather
 * than part of `admin.ts`: that module exists to be the one place with
 * cross-owner reach, and routing every visitor's request through it would blunt
 * the point. The *write* is an operator action and does live there.
 */

export type OperatorFlag = 'live_chat_paused'

export async function isFlagSet(key: OperatorFlag): Promise<boolean> {
  const [row] = await adminDb()
    .select({ value: operatorFlags.value })
    .from(operatorFlags)
    .where(eq(operatorFlags.key, key))
    .limit(1)
  // Absent means off. A kill switch that fails *on* would take the site down
  // the first time this table is empty, which is every fresh database.
  return row?.value === true
}

export async function setFlag(key: OperatorFlag, value: boolean): Promise<void> {
  await adminDb()
    .insert(operatorFlags)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: operatorFlags.key, set: { value, updatedAt: new Date() } })
}

export const isLiveChatPaused = (): Promise<boolean> => isFlagSet('live_chat_paused')
