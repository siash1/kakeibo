import { resetEnvCache } from '@kakeibo/core/env'
import { afterEach, describe, expect, it } from 'vitest'
import { resetAndSeed } from './runner'

/**
 * Regression test for the reset-guard/truncate mismatch (final whole-branch
 * review, finding 4): `resetAndSeed` used to guard `DATABASE_URL` with
 * `assertResettable` and then truncate through `getDb()`, which connects to
 * `APP_DATABASE_URL || DATABASE_URL` (packages/ledger/src/db.ts). A local
 * `DATABASE_URL` beside a hosted `APP_DATABASE_URL` passed the guard and then
 * truncated the remote ledger — exactly the failure the guard exists to
 * prevent. `packages/ledger/src/scripts/reset.ts` never had this bug because
 * it guards and truncates through the same `adminDb()`/`DATABASE_URL` pair.
 *
 * Every case below is a refusal. `assertResettable` throws synchronously
 * before `resetAndSeed` ever calls `getDb()`, so none of these attempt to
 * connect to the (fictitious) remote host, let alone truncate anything —
 * safe to run inside the same shared-schema suite as every other DB test
 * here without disturbing their fixtures.
 */
describe('resetAndSeed', () => {
  afterEach(() => {
    delete process.env.DATABASE_URL
    delete process.env.APP_DATABASE_URL
    delete process.env.ALLOW_DESTRUCTIVE_RESET
    resetEnvCache()
  })

  it('refuses when APP_DATABASE_URL — the URL actually truncated — is not local, even though DATABASE_URL is', async () => {
    process.env.DATABASE_URL = 'postgres://kakeibo:kakeibo@localhost:5433/kakeibo'
    process.env.APP_DATABASE_URL =
      'postgres://user:pw@ep-cool-name-123456.ap-south-1.aws.neon.tech/kakeibo'
    resetEnvCache()

    // This is the exact scenario the finding describes: before the fix, the
    // guard checked the local DATABASE_URL, passed, and resetAndSeed went on
    // to truncate through APP_DATABASE_URL — the hosted one — unguarded.
    await expect(resetAndSeed()).rejects.toThrow(/refusing/i)
    // The message has to name the host that was actually about to be
    // truncated, not the one that happened to look local.
    await expect(resetAndSeed()).rejects.toThrow(/neon\.tech/)
  })

  it('still refuses a remote DATABASE_URL when APP_DATABASE_URL is unset, the ordinary case', async () => {
    process.env.DATABASE_URL =
      'postgres://user:pw@ep-cool-name-123456.ap-south-1.aws.neon.tech/kakeibo'
    delete process.env.APP_DATABASE_URL
    resetEnvCache()

    await expect(resetAndSeed()).rejects.toThrow(/neon\.tech/)
  })
})
