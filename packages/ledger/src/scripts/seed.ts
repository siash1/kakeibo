import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnv } from '@kakeibo/core/env'
import { toCsv } from '../csv'
import { closeDb } from '../db'
import { commitImport, planImport } from '../import'
import { formatMinor, minorToDecimalString } from '../money'
import { DEV_OWNER_ID } from '../owner'
import { ensureSeedAccounts } from '../repo/accounts'
import { findUnbalancedTransactions } from '../repo/transactions'
import { generateSeedData, RATES } from '../seed/generate'

/**
 * `pnpm db:seed` — writes the deterministic fixtures to data/seed/ and imports
 * them through the *real* import path, so the seeded ledger is exactly what a
 * user would get by importing that CSV themselves. Nothing is inserted by a
 * back door that the tools cannot reproduce.
 */

loadEnv()

const repoRoot = process.cwd().replace(/\/(packages|apps)\/[^/]+$/, '')
const seedDir = join(repoRoot, 'data', 'seed')

async function main(): Promise<void> {
  const { rows, labels } = generateSeedData()

  mkdirSync(seedDir, { recursive: true })

  const csv = toCsv(
    rows.map((row) => ({
      date: row.date,
      description: row.description,
      amount: minorToDecimalString(row.amountMinor),
      category: row.csvCategory,
    })),
    ['date', 'description', 'amount', 'category'],
  )
  writeFileSync(join(seedDir, 'transactions.csv'), csv)
  writeFileSync(join(seedDir, 'labels.json'), `${JSON.stringify(labels, null, 2)}\n`)
  writeFileSync(join(seedDir, 'rates.json'), `${JSON.stringify(RATES, null, 2)}\n`)

  console.log(`Wrote ${rows.length} rows to data/seed/transactions.csv`)
  console.log(
    `  ${labels.totals.uncategorizedCount} rows have no category and import as Uncategorized`,
  )
  console.log(`  ${labels.hostile.length} hostile descriptions planted`)
  console.log(`  ${labels.anomalies.length} anomalies planted`)

  await ensureSeedAccounts(DEV_OWNER_ID)
  console.log('Chart of accounts ready.')

  const { preview, resolved } = await planImport(
    DEV_OWNER_ID,
    'data/seed/transactions.csv',
    csv,
    'sample',
  )
  if (preview.parseErrors.length > 0) {
    console.error('Seed CSV failed to parse cleanly:', preview.parseErrors.slice(0, 5))
    process.exitCode = 1
    await closeDb()
    return
  }

  const result = await commitImport(DEV_OWNER_ID, 'data/seed/transactions.csv', resolved, preview, {
    deterministicIds: true,
  })
  console.log(`Imported ${result.imported} transactions (batch ${result.importBatchId})`)
  console.log(`  in:  ${formatMinor(result.totalInMinor)}`)
  console.log(`  out: ${formatMinor(result.totalOutMinor)}`)

  // The invariant is asserted here as well as in the test suite, because a seed
  // that quietly unbalances the ledger would poison every eval downstream.
  const unbalanced = await findUnbalancedTransactions(DEV_OWNER_ID)
  if (unbalanced.length > 0) {
    console.error(`FATAL: ${unbalanced.length} unbalanced transaction(s) after seeding.`)
    process.exitCode = 1
  } else {
    console.log('Double-entry invariant holds: every transaction sums to zero.')
  }

  await closeDb()
}

main().catch(async (error) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error)
  await closeDb()
  process.exit(1)
})
