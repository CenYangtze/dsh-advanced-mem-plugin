import { defineConfig } from 'tsdown'

/** Harness loads web companions through its shared browser module registry. */
export default defineConfig({
  entry: { client: 'src/experience-harness/client/index.ts' },
  outDir: 'lib/experience-harness',
  format: 'cjs', platform: 'browser', target: 'es2022',
  clean: false, dts: false, sourcemap: false,
  outExtensions: () => ({ js: '.js' }),
  deps: { neverBundle: [/^@deepseek-ai\//, 'react'] },
  banner: "window.__ModuleLoader__.load({ id: 'dsh-advanced-mem-plugin', factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;",
  footer: 'return module.exports; } });',
})
