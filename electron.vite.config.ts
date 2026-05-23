import { builtinModules, createRequire } from 'node:module'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Build the externals list ourselves rather than relying solely on
// externalizeDepsPlugin, because:
//   1. electron lives in devDependencies (the plugin only reads
//      dependencies), so it would get bundled — pulling in the npm
//      launcher helper with its install.js plumbing that crashes at
//      runtime.
//   2. Explicit `rollupOptions.external` can shadow what the plugin
//      contributes, so we need a single source of truth. Bundling
//      runtime deps like pino breaks pino's worker-thread transport
//      mechanism (it spawns a thread that needs to `require` the
//      original module).
const pkg = createRequire(import.meta.url)('./package.json') as {
  dependencies?: Record<string, string>
}
const runtimeDeps = Object.keys(pkg.dependencies ?? {})
const mainExternal: Array<string | RegExp> = [
  'electron',
  /^electron\//,
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  ...runtimeDeps,
  // also externalize anything under a runtime dep's subpath
  ...runtimeDeps.map((d) => new RegExp(`^${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`)),
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: mainExternal,
        input: {
          index: resolve('src/main/index.ts'),
          worker: resolve('src/worker/index.ts'),
        },
        output: {
          // Force CJS + .js extension so electron-vite dev mode can find
          // out/main/index.js. Multi-entry input defaults to ESM (.mjs)
          // otherwise, which breaks electron-vite's entry detection.
          format: 'cjs',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
        },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
        '@worker': resolve('src/worker'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
})
