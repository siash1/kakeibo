/**
 * Who a row belongs to.
 *
 * Branded rather than a bare string on purpose. This value is about to become
 * the first parameter of roughly two dozen repository functions that already
 * take accountId, transactionId and month as strings — and `f(accountId,
 * ownerId)` instead of `f(ownerId, accountId)` compiles perfectly happily if
 * they are all just strings. Branding turns that into a type error at the call
 * site, which is the only place it is cheap to catch.
 */
export type OwnerId = string & { readonly __owner: unique symbol }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function asOwnerId(value: string): OwnerId {
  if (!UUID.test(value)) {
    throw new Error(`Invalid OwnerId: ${JSON.stringify(value)} is not a UUID`)
  }
  return value as OwnerId
}

/**
 * The owner every local surface uses until Plan B introduces real sessions:
 * the CLI, the MCP server, `pnpm db:seed` and the eval harness.
 *
 * A fixed constant rather than a generated one so that a reseed does not orphan
 * the previous run's data, and so eval `sql_equals` oracles stay stable.
 */
export const DEV_OWNER_ID: OwnerId = asOwnerId('00000000-0000-4000-8000-000000000001')
