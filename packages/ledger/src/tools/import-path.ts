import { isAbsolute, resolve, sep } from 'node:path'

/**
 * Where `import_statement_csv` may read from, and nowhere else.
 *
 * The tool takes a path from the model, which takes it from whoever is talking
 * to the model — and on the public site that is an anonymous visitor. The
 * dry-run preview then returns `parseErrors[].raw`, which is the literal text
 * of the lines it could not parse. Unconfined, those two facts compose into an
 * arbitrary-file-read oracle behind a confirmation the attacker gives
 * themselves: `/proc/self/environ` on the deployed host is every secret the
 * process holds, and a CSV parser is happy to report the whole of it as
 * unparseable rows.
 *
 * `data/` is already this repo's convention for statement data — `data/seed/`
 * for the synthetic corpus, `data/private/` (gitignored, CLAUDE.md rule 5) for
 * anything real — so confining imports to it costs no existing caller anything.
 * The eval harness's `data/seed/transactions.csv` and the CLI's own imports
 * both already live inside it.
 *
 * Relative paths still resolve from the repository root, because that is what
 * every existing caller passes and what the tool's own description promises.
 * Absolute paths are accepted only if they land inside `data/`, and `..`
 * cannot climb out of it.
 *
 * The check is a prefix comparison rather than a `realpath`, deliberately: the
 * path may not exist yet, and refusing before touching the filesystem is what
 * keeps this from also being an existence oracle. A symlink planted inside
 * `data/` would escape it — nothing in this application can write a file to
 * the server, so planting one is not a move an attacker has.
 */
export function resolveImportPath(input: string): string {
  const root = repoRoot()
  const allowed = resolve(root, 'data')
  const target = isAbsolute(input) ? resolve(input) : resolve(root, input)

  if (target !== allowed && !target.startsWith(allowed + sep)) {
    // Names the rule, not the file: an error that reported what it found on
    // disk would be the oracle this function exists to close.
    throw new Error(`Imports may only read from data/. Refusing "${input}".`)
  }
  return target
}

/** The repository root, whether the process started there or in a workspace. */
function repoRoot(): string {
  return process.cwd().replace(/\/(packages|apps)\/[^/]+$/, '')
}
