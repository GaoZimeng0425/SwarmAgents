// Shared Electron fixture: each test gets a freshly launched app on an
// isolated temp user-data-dir, torn down (and cleaned up) afterwards.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test as base, type ElectronApplication, _electron as electron, expect, type Page } from '@playwright/test'

type Fixtures = { electronApp: ElectronApplication; page: Page }

export const test = base.extend<Fixtures>({
  electronApp: async ({}, use) => {
    const userDataDir = mkdtempSync(resolve(tmpdir(), 'swarm-e2e-'))
    const app = await electron.launch({
      executablePath: require('electron') as string,
      args: [resolve('out/main/index.js'), `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        SWARM_E2E: '1',
        // Bind the WS host away from 47777 so e2e does not clash with the
        // user's running app on the default port. See auth.ts resolvePort().
        SWARM_WS_HOST_PORT: '47877',
      },
    })
    await use(app)
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  },
})

export { expect }
