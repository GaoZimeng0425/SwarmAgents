import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'wxt'

// WXT auto-generates manifest.json from entrypoints + the manifest block below.
// @swarm/protocol and @swarm/ui are bundled from source via the vite aliases
// (no package build). Tailwind v4 is wired through @tailwindcss/vite; each
// entrypoint imports its globals.css which pulls the shared token CSS.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'SwarmAgents',
    version: '0.1.0',
    description: 'Quick launcher for the SwarmAgents desktop runtime.',
    permissions: ['storage', 'alarms'],
    host_permissions: ['ws://127.0.0.1:47777/*', 'http://127.0.0.1:47777/*'],
    // With the popup entrypoint removed (side panel replaces it), WXT no longer
    // generates an `action` block — but MV3 needs one for the toolbar icon to
    // appear and for action.onClicked to fire (which opens the side panel). The
    // icon defaults to Chrome's generic until custom icons are added.
    action: { default_title: 'SwarmAgents' },
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
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@swarm/protocol': resolve(__dirname, '../../packages/protocol/src'),
        '@swarm/ui': resolve(__dirname, '../../packages/ui/src'),
      },
    },
  }),
})
