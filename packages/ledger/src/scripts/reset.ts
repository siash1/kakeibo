import { env, loadEnv } from '@kakeibo/core/env'
import { sql } from 'drizzle-orm'
import { adminDb, closeDb } from '../db'

/**
 * `pnpm db:reset` — truncates ledger data, keeps the schema.
 *
 * Every eval task starts from `reset_and_seed` (spec 11), so this runs
 * constantly and has to be fast and total. Trace tables are included: an eval
 * run's metrics should describe that run, not accumulate across all of them.
 */

loadEnv()

/**
 * Refuses to truncate a database that is not obviously a local one.
 *
 * `pnpm eval` calls resetAndSeed before every task, so this code path runs
 * constantly and truncates every ledger table. The failure mode it exists to
 * prevent is not subtle: a production DATABASE_URL in a local shell, one
 * `pnpm eval`, and the ledger is gone.
 *
 * Fails closed on anything it cannot parse. The cost of a false refusal is
 * retyping a command with ALLOW_DESTRUCTIVE_RESET=1.
 */
export function assertResettable(databaseUrl: string, allowDestructive: boolean): void {
  if (allowDestructive) return

  let host: string
  try {
    host = new URL(databaseUrl).hostname
  } catch {
    throw new Error(
      'Refusing to reset: DATABASE_URL could not be parsed, so its host is unknown. ' +
        'Set ALLOW_DESTRUCTIVE_RESET=1 if you are certain.',
    )
  }

  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  if (!local) {
    throw new Error(
      `Refusing to reset a non-local database (host: ${host}). ` +
        'This truncates every ledger table. Set ALLOW_DESTRUCTIVE_RESET=1 if you are certain.',
    )
  }
}

async function main(): Promise<void> {
  assertResettable(env().DATABASE_URL, env().ALLOW_DESTRUCTIVE_RESET)
  // adminDb: truncating every owner's data is precisely what the app role
  // must not be able to do.
  await adminDb().execute(
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
