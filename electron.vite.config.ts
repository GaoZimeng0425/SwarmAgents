import { builtinModules, createRequire } from 'node:module'
import { resolve } from 'node:path'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
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

// @earendil-works/pi-agent-core and @earendil-works/pi-ai are ESM-only
// (their package.json exports only have "import", no "require"). The worker
// bundle is emitted as CJS (forced by electron-vite's single-output
// constraint), so these packages must be inlined by Rollup rather than
// externalized. Rollup's CJS plugin handles the ESM→CJS transpilation.
const ESM_ONLY_BUNDLE_INLINE = new Set(['@earendil-works/pi-agent-core', '@earendil-works/pi-ai'])

// Transitive deps that MUST stay external even though they're not listed in
// package.json `dependencies` (so the runtimeDeps scan misses them). jsdom is
// imported by src/service/tools/web.ts; bundling it breaks its runtime
// `readFileSync(resolve(__dirname, "../../../browser/default-stylesheet.css"))`
// because the bundle's __dirname is out/main, not node_modules/jsdom. Keep it
// external so it loads from node_modules where that relative path resolves.
const EXTRA_EXTERNALS = ['jsdom']

const mainExternal: Array<string | RegExp> = [
  'electron',
  /^electron\//,
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  ...EXTRA_EXTERNALS,
  ...EXTRA_EXTERNALS.map((d) => new RegExp(`^${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`)),
  ...runtimeDeps.filter((d) => !ESM_ONLY_BUNDLE_INLINE.has(d)),
  // also externalize anything under a runtime dep's subpath (skip ESM-only inline set)
  ...runtimeDeps
    .filter((d) => !ESM_ONLY_BUNDLE_INLINE.has(d))
    .map((d) => new RegExp(`^${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`)),
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: mainExternal,
        input: {
          index: resolve('src/main/index.ts'),
          service: resolve('src/service/index.ts'),
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
        '@service': resolve('src/service'),
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
        '@': resolve('src/renderer/src'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          settings: resolve('src/renderer/settings.html'),
        },
      },
    },
    plugins: [
      TanStackRouterVite({
        target: 'react',
        autoCodeSplitting: true,
        routesDirectory: resolve('src/renderer/src/routes'),
        generatedRouteTree: resolve('src/renderer/src/routeTree.gen.ts'),
      }),
      TanStackRouterVite({
        target: 'react',
        autoCodeSplitting: true,
        routesDirectory: resolve('src/renderer/src/routes-settings'),
        generatedRouteTree: resolve('src/renderer/src/routeTreeSettings.gen.ts'),
      }),
      react(),
      babel({
        presets: [reactCompilerPreset({ target: '19' })],
      }),
      tailwindcss(),
    ],
  },
})
