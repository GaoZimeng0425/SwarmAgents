import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', '../../packages/*/src/**/*.test.ts'],
    environment: 'node',
    environmentMatchGlobs: [['src/renderer/**', 'jsdom']],
    setupFiles: ['./src/renderer/test-setup.ts'],
    testTimeout: 10_000,
    pool: 'forks',
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@service': resolve(__dirname, 'src/service'),
      '@': resolve(__dirname, 'src/renderer/src'),
      '@swarm/protocol': resolve(__dirname, '../../packages/protocol/src'),
      '@swarm/shared': resolve(__dirname, '../../packages/shared/src'),
    },
  },
})
