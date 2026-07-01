// src/main/system/url-scheme.ts
//
// Registers swarmagents:// as a default protocol client. On macOS routes via
// `open-url`; on Windows the second-instance argv is parsed in main/index.ts.
import { resolve } from 'node:path'
import { app } from 'electron'

export function registerUrlScheme(scheme: string, onDeepLink: (url: string) => void): void {
  // In dev (`process.defaultApp`), the OS must be told to relaunch the Electron
  // binary with our entry script; the bare form only works for packaged apps.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(scheme, process.execPath, [resolve(process.argv[1])])
  } else {
    app.setAsDefaultProtocolClient(scheme)
  }
  app.on('open-url', (e, url) => {
    e.preventDefault()
    onDeepLink(url)
  })
}

export function parseDeepLinkFromArgv(argv: string[], scheme: string): string | null {
  const prefix = `${scheme}://`
  return argv.find((a) => a.startsWith(prefix)) ?? null
}
