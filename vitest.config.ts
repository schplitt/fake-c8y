import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // the real-tenant contract run has its own config (pnpm test:contract)
    exclude: ['**/node_modules/**', 'tests/contract/real-tenant.test.ts'],
  },
})
