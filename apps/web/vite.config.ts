import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  css: {
    transformer: 'lightningcss',
    lightningcss: {
      // Packed semver (major<<16 | minor<<8). The modern baseline Tailwind v4
      // itself assumes, so both CSS engines lower against the same floor.
      targets: {
        chrome: 111 << 16,
        safari: (16 << 16) | (4 << 8),
        firefox: 128 << 16,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
  },
})
