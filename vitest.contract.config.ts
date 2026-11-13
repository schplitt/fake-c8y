import { defineConfig } from 'vitest/config'

// Contract scenarios against a real tenant (see tests/contract/real-tenant.test.ts).
export default defineConfig({
  test: {
    include: ['tests/contract/real-tenant.test.ts'],
    // one tenant, one scenario at a time
    fileParallelism: false,
    // a real tenant can be slow (series of 5000 points, microservice
    // subscriptions, cleanup of many objects), more so from CI runners
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
})
