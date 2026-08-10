import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveImportPath } from './import-path'

/**
 * The containment on `import_statement_csv`, which is the only tool that reads
 * the server's filesystem.
 *
 * This is not a hypothetical: the tool is in the registry `/api/chat` serves,
 * so the path comes from an anonymous visitor by way of the model, and the
 * dry-run preview returns `parseErrors[].raw` — the literal lines it could not
 * parse. Before this check, "import /proc/self/environ" was a request the agent
 * would happily carry out once the visitor confirmed their own write gate, and
 * every secret the process holds would come back as unparseable rows.
 */
const root = process.cwd().replace(/\/(packages|apps)\/[^/]+$/, '')

describe('resolveImportPath', () => {
  it('accepts what every existing caller passes', () => {
    // The eval harness's task and the seed script both name this exact path.
    expect(resolveImportPath('data/seed/transactions.csv')).toBe(
      resolve(root, 'data/seed/transactions.csv'),
    )
    // Real statements live here, gitignored (CLAUDE.md rule 5).
    expect(resolveImportPath('data/private/march.csv')).toBe(
      resolve(root, 'data/private/march.csv'),
    )
    // An absolute path is fine as long as it lands inside data/.
    expect(resolveImportPath(resolve(root, 'data/seed/transactions.csv'))).toBe(
      resolve(root, 'data/seed/transactions.csv'),
    )
  })

  it('refuses to read outside data/', () => {
    for (const attempt of [
      '/etc/passwd',
      '/proc/self/environ',
      resolve(root, '.env'),
      '.env',
      'packages/ledger/src/tools/index.ts',
      'data/../.env',
      'data/../../.env',
      '../.env',
    ]) {
      expect(() => resolveImportPath(attempt), attempt).toThrow(/only read from data\//)
    }
  })

  it('names the rule and not the file', () => {
    // An error that reported what it found on disk would be the oracle the
    // check exists to close: "no such file" and "permission denied" are both
    // answers to a question the caller was not entitled to ask.
    expect(() => resolveImportPath('/etc/shadow')).toThrow(
      'Imports may only read from data/. Refusing "/etc/shadow".',
    )
  })
})
