import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Keep vitest's optimize-deps cache separate from `electron-vite dev`, which
  // uses the default node_modules/.vite. Sharing it lets a test run overwrite
  // the dev server's pre-bundled deps with a test-only subset, making lazy
  // route chunks fail to load until the dev cache is rebuilt.
  cacheDir: 'node_modules/.vitest',
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
