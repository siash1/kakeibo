import { loadEnv } from '@kakeibo/core/env'
import { closeDb } from '../db'
import { reap } from '../repo/reaper'

/**
 * `pnpm db:reap` — the nightly sweep.
 *
 * Deletes anonymous users past the 24-hour retention window the UI promises,
 * abandoned suspended turns, and yesterday's rate-limit counters. Plan C runs
 * this from a Vercel cron; locally it is a command.
 */

loadEnv()

async function main(): Promise<void> {
  const result = await reap()
  console.log(`Reaped ${result.anonymousUsers} anonymous user(s) and their ledgers.`)
  console.log(`  ${result.suspendedTurns} abandoned confirmation(s)`)
  console.log(`  ${result.rateLimits} stale rate-limit counter(s)`)
  await closeDb()
}

main().catch(async (error) => {
  console.error('Reap failed:', error instanceof Error ? error.message : error)
  await closeDb()
  process.exit(1)
})
