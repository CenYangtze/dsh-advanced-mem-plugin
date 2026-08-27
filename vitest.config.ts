import { defineConfig } from 'vitest/config'

/**
 * Tests run against `src/` directly — the suites drive the real plugin bodies
 * on real Cordis registries, so they need the harness packages installed. From
 * a plain clone that means `pnpm install` in a checkout of the harness beside
 * this one; see README.md § Developing.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
