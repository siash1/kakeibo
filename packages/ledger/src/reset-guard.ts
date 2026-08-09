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
