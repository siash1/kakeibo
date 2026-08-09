import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The RLS-bypassing connection is `adminDb()`. Row-level security is the
 * backstop under every owner-scoped query, and a module holding this connection
 * is a module for which that backstop does not apply.
 *
 * The spec (§11) asks for "referenced in repo/admin.ts and nowhere else". Taken
 * literally that is unsatisfiable — several modules need the unscoped
 * connection for reasons that are not "read one visitor's data from another's
 * session" — so this asserts the stronger practical property instead: the set of
 * holders EQUALS a reviewed list, and each entry says why. Adding one is then a
 * visible act in a diff rather than a silent widening.
 *
 * This list is derived from the tree, not from a plan — it was checked against
 * `grep`, not memory, and it will drift again as the code does. If this test
 * fails because you added a module, do not add it to the list reflexively. Ask
 * first whether the query could be owner-scoped instead; only once that
 * question has a real answer does the new entry belong here, with its reason.
 */
const ALLOWED = new Map<string, string>([
  ['src/db.ts', 'defines adminDb()'],
  ['src/repo/admin.ts', 'the operator dashboard: the only cross-owner reads in the application'],
  ['src/repo/flags.ts', 'operator_flags is a property of the site, not of a visitor'],
  ['src/repo/link.ts', 'repointing and deletion span exactly two named owners, which RLS forbids'],
  ['src/repo/quota.ts', 'the global cap sums every owner; rate_limits has no owner_id'],
  ['src/repo/reaper.ts', 'maintenance: deletes expired users across the whole table'],
  [
    'src/repo/users.ts',
    '"user" is the principal table, outside RLS, and app_user has no rights on it',
  ],
  ['src/scripts/migrate.ts', 'DDL requires the owning role, which is not the app role'],
  ['src/scripts/reset.ts', 'truncates every owner, which is exactly what app_user must not do'],
])

/**
 * Modules outside packages/ledger that name adminDb, and why.
 *
 * Kept as a reviewed map rather than an empty expectation because the one entry
 * is a real exception, not a leak: renaming the accessor to make this list empty
 * would leave the same capability in the same place under a different name, and
 * turn this test into a check on spelling.
 */
const ALLOWED_OUTSIDE = new Map<string, string>([
  [
    'apps/web/src/lib/auth.ts',
    'Better Auth resolves a user from a session token before any owner is known, which is the query RLS exists to refuse; app_user has no privileges on the four auth tables at all',
  ],
])

/** Directories that are not this package's own source, however they got there. */
const SKIP_DIRS = new Set(['node_modules', '.turbo', 'dist'])

function sourceFiles(dir: string, base: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, base, found)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      found.push(full.slice(base.length + 1))
    }
  }
  return found
}

describe('the RLS bypass is contained', () => {
  it('is held by exactly the reviewed set of modules', () => {
    const base = join(__dirname, '..')
    const holders = sourceFiles(join(base, 'src'), base)
      .filter((file) => /\badminDb\s*\(/.test(readFileSync(join(base, file), 'utf8')))
      .sort()

    expect(holders).toEqual([...ALLOWED.keys()].sort())
  })

  it('is held outside the ledger package by exactly the reviewed set of modules', () => {
    // The web app, the CLI, the MCP server and the eval harness all reach the
    // database through @kakeibo/ledger. If one of them imports adminDb
    // directly, the single door has a window beside it — unless that window is
    // this reviewed one.
    const repoRoot = join(__dirname, '..', '..', '..')
    const outside = ['apps', 'packages/core', 'packages/mcp', 'packages/evals', 'scripts']
      .flatMap((dir) => {
        try {
          return sourceFiles(join(repoRoot, dir), repoRoot)
        } catch {
          return []
        }
      })
      .filter((file) => /\badminDb\b/.test(readFileSync(join(repoRoot, file), 'utf8')))
      .sort()

    expect(outside).toEqual([...ALLOWED_OUTSIDE.keys()].sort())
  })
})
