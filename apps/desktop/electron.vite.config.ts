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
// chokidar (5.x) + its only dep readdirp are ESM-only too and have no native
// modules, so the service's skill-folder watcher inlines them the same way.
const ESM_ONLY_BUNDLE_INLINE = new Set(['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', 'chokidar'])

// @swarm/protocol and @swarm/shared are workspace source packages consumed via
// tsconfig paths / vite aliases — they must be BUNDLED from source, not
// externalized (externalizing would make node try to require .ts at runtime).
const SWARM_PACKAGES = /^@swarm\//

const mainExternal: Array<string | RegExp> = [
  'electron',
  /^electron\//,
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  ...runtimeDeps.filter((d) => !ESM_ONLY_BUNDLE_INLINE.has(d) && !SWARM_PACKAGES.test(d)),
  // also externalize anything under a runtime dep's subpath (skip ESM-only inline set)
  ...runtimeDeps
    .filter((d) => !ESM_ONLY_BUNDLE_INLINE.has(d) && !SWARM_PACKAGES.test(d))
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
        '@swarm/protocol': resolve('../../packages/protocol/src'),
        '@swarm/shared': resolve('../../packages/shared/src'),
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
        '@swarm/protocol': resolve('../../packages/protocol/src'),
        '@swarm/shared': resolve('../../packages/shared/src'),
      },
    },
    optimizeDeps: {
      // TanStack autoCodeSplitting serves each route as a dynamic import; under
      // turbo-driven parallel dev (desktop + extension) the renderer window can
      // open before Vite finishes pre-bundling, surfacing as a stuck 504
      // "Outdated Optimize Dep" on the lazy route chunk (Electron doesn't
      // auto-reload through it). Crawl every route file as an optimize entry so
      // deps reachable only via lazy chunks are pre-bundled at server start.
      entries: ['src/renderer/index.html', 'src/renderer/src/routes/**/*.tsx'],
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
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
      react(),
      babel({
        presets: [reactCompilerPreset({ target: '19' })],
      }),
      tailwindcss(),
    ],
  },
})
