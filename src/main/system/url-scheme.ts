// src/main/system/url-scheme.ts
//
// Registers swarmagents:// as a default protocol client. On macOS routes via
// `open-url`; on Windows the second-instance argv is parsed in main/index.ts.
import { app } from 'electron'

export function registerUrlScheme(
  scheme: string,
  onDeepLink: (url: string) => void,
): void {
  app.setAsDefaultProtocolClient(scheme)
  app.on('open-url', (e, url) => {
    e.preventDefault()
    onDeepLink(url)
  })
}

export function parseDeepLinkFromArgv(argv: string[], scheme: string): string | null {
  const prefix = `${scheme}://`
  return argv.find((a) => a.startsWith(prefix)) ?? null
}
