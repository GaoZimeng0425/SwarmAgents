import { resolve } from 'node:path'
import { defineConfig } from 'wxt'

// WXT auto-generates manifest.json from entrypoints + the manifest block below.
// @swarm/protocol is bundled from source via the vite alias (no package build).
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'SwarmAgents',
    version: '0.1.0',
    description: 'Quick launcher for the SwarmAgents desktop runtime.',
    permissions: ['storage', 'alarms'],
    host_permissions: ['ws://127.0.0.1:47777/*', 'http://127.0.0.1:47777/*'],
  },
  // Use Dia as the dev browser instead of Chrome. WXT's `dev` command otherwise
  // spawns Chrome via chrome-launcher and fails with ChromeNotInstalledError on
  // machines that only have Dia installed. Dia is Chromium-based, so web-ext's
  // chromium runner drives it directly.
  webExt: {
    binaries: {
      chrome: '/Applications/Dia.app/Contents/MacOS/Dia',
    },
  },
  vite: () => ({
    resolve: {
      alias: {
        '@swarm/protocol': resolve(__dirname, '../../packages/protocol/src'),
      },
    },
  }),
})
