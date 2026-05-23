import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    pool: 'forks', // each test file in its own subprocess — needed for worker-spawn tests
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@worker': resolve(__dirname, 'src/worker'),
    },
  },
})
