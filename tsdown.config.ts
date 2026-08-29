import { defineConfig } from 'tsdown'

/**
 * The `prepare`-time build. pnpm runs it after a git install, where none of the
 * harness monorepo exists — so this config must be self-contained: no project
 * references, no workspace paths, and no type checking against peer packages
 * that are only resolvable inside a real profile.
 *
 * `dts` emits declarations from this package's own sources; peer types resolve
 * when the consumer has the harness installed and are `any` otherwise, which is
 * correct for a runtime artifact whose types are a development convenience.
 */
export default defineConfig({
  entry: [
    'src/memory/index.ts',
    'src/memory/invariant.ts',
    'src/memory-store-domain/index.ts',
    'src/memory-embedding-hash/index.ts',
    'src/memory-observer/index.ts',
    'src/memory-consolidation/index.ts',
    'src/memory-recall/index.ts',
    'src/tool-memory/index.ts',
    'src/command-memory/index.ts',
  ],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // One file per entry, with the shared hub imported rather than inlined: the
  // Cordis Loader mounts several of these rows in one process, and a duplicated
  // MemoryRuntime class would give each row its own service identity.
  unbundle: true,
  dts: true,
  clean: true,
  sourcemap: false,
  // `"type": "module"` makes a bare .js ESM, so the emitted names match the
  // exports map and a consumer never sees a second extension convention.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  // Everything the harness owns comes from the host installation: bundling a
  // copy in here would give the process a second cordis and a second registry.
  deps: { neverBundle: [/^@deepseek-ai\//, /^node:/, 'zod'] },
})
