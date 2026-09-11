import { defineConfig } from 'vitest/config'

// Isolated acceptance config: only the M5 acceptance spec runs here, and it is
// intentionally excluded from the default `tests/**` unit suite.
export default defineConfig({
  test: {
    include: ['eval/m5/acceptance.spec.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
})
