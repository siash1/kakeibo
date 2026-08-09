import { toCsv } from '../csv'
import { commitImport, planImport } from '../import'
import { minorToDecimalString } from '../money'
import type { OwnerId } from '../owner'
import { generateSeedData } from '../seed/generate'
import { ensureSeedAccounts, listAccounts } from './accounts'

/**
 * The per-visitor demo ledger (spec §8).
 *
 * Every visitor gets their own copy of the 352-row synthetic corpus, cloned
 * lazily on the first request that actually needs a ledger rather than on page
 * load — so a crawler, a bounce or someone reading the landing page costs
 * nothing. Roughly 140 KB and one batch of 352 transactions plus 704 postings.
 *
 * It goes in through the real import path, exactly as `pnpm db:seed` does, so
 * what a visitor gets is what they would get by importing that CSV themselves.
 * Nothing arrives through a back door the tools cannot reproduce.
 */

let seedCsv: string | undefined

/** Built once per process: deterministic, and ~40 KB of string work. */
function corpus(): string {
  if (seedCsv) return seedCsv
  const { rows } = generateSeedData()
  seedCsv = toCsv(
    rows.map((row) => ({
      date: row.date,
      description: row.description,
      amount: minorToDecimalString(row.amountMinor),
      category: row.csvCategory,
    })),
    ['date', 'description', 'amount', 'category'],
  )
  return seedCsv
}

/**
 * Gives an owner a ledger if they have none. A no-op once they do.
 *
 * **Not** `deterministicIds`. The seed script uses reproducible primary keys so
 * that replay fixtures and eval oracles survive a reseed, but those keys are
 * derived from the CSV row alone and carry no owner — so the second visitor to
 * be cloned would collide with the first on the transactions primary key.
 * Fixtures are a single-owner concern; visitors get database-generated keys.
 */
export async function ensureLedger(owner: OwnerId): Promise<{ created: boolean }> {
  // Accounts are the marker: ensureSeedAccounts is the first thing any ledger
  // gets, and the chart of accounts is what every other table hangs off.
  if ((await listAccounts(owner)).length > 0) return { created: false }

  await ensureSeedAccounts(owner)
  const csv = corpus()
  const { preview, resolved } = await planImport(owner, 'demo-ledger.csv', csv, 'sample')
  await commitImport(owner, 'demo-ledger.csv', resolved, preview)
  return { created: true }
}
