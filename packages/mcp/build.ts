import { build } from 'esbuild'

/**
 * Bundles the MCP server into a single file so it can be registered as
 * `node <abs-path>/packages/mcp/dist/index.js` without the client needing to
 * know about pnpm workspaces or a TypeScript loader.
 *
 * `pg` stays external because it resolves optional native bindings at runtime
 * that a bundler inlines incorrectly; it is therefore a real dependency of this
 * package, not just of the ledger. Nothing else needs to be external — in
 * particular @google/genai is absent from this bundle entirely, which is the
 * intended shape: the MCP server serves tools and makes no model calls.
 */
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/index.js',
  external: ['pg', 'pg-native'],
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
  logLevel: 'info',
})
