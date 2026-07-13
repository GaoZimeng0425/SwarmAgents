import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { createQuickPanelStore, DEFAULT_HOTKEY } from './store'

const tmpFile = join(tmpdir(), `qp-store-${process.pid}-${Date.now()}.json`)

describe('createQuickPanelStore', () => {
  beforeEach(async () => {
    await rm(tmpFile, { force: true })
  })

  it('returns default hotkey when file is missing', async () => {
    const store = createQuickPanelStore({ filePath: tmpFile })
    const config = await store.load()
    expect(config.hotkey).toBe(DEFAULT_HOTKEY)
  })

  it('round-trips a saved config', async () => {
    const store = createQuickPanelStore({ filePath: tmpFile })
    await store.save({ hotkey: 'CommandOrControl+Alt+P' })
    const loaded = await store.load()
    expect(loaded.hotkey).toBe('CommandOrControl+Alt+P')
  })

  it('returns default on corrupt JSON', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(tmpFile, '{ not valid json')
    const store = createQuickPanelStore({ filePath: tmpFile })
    const config = await store.load()
    expect(config.hotkey).toBe(DEFAULT_HOTKEY)
  })
})
