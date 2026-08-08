import { loadEnv } from '@kakeibo/core/env'
import { sql } from 'drizzle-orm'
import { closeDb, getDb } from '../db'

/**
 * `pnpm db:reset` — truncates ledger data, keeps the schema.
 *
 * Every eval task starts from `reset_and_seed` (spec 11), so this runs
 * constantly and has to be fast and total. Trace tables are included: an eval
 * run's metrics should describe that run, not accumulate across all of them.
 */

loadEnv()

async function main(): Promise<void> {
  await getDb().execute(
    sql`truncate table trace_events, trace_runs, postings, transactions, import_batches, budgets, rules, memories, accounts restart identity cascade`,
  )
  console.log('Ledger truncated.')
  await closeDb()
}

main().catch(async (error) => {
  console.error('Reset failed:', error instanceof Error ? error.message : error)
  await closeDb()
  process.exit(1)
})
