import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// safeStorage isn't available under ELECTRON_RUN_AS_NODE; stub it with a
// reversible base64 "cipher" so the store's encrypt/decrypt path is exercised.
vi.mock('electron', () => ({
  safeStorage: {
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}))

import { createStore } from './store'

let dir: string
let filePath: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'bili-store-'))
  filePath = join(dir, 'bilibili.bin')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('bilibili store', () => {
  it('returns defaults when file is missing', async () => {
    const store = createStore({ filePath })
    expect(await store.load()).toEqual({ credentials: null })
  })

  it('round-trips saved credentials', async () => {
    const store = createStore({ filePath })
    await store.save({ credentials: { sessdata: 's', biliJct: 'j', dedeUserId: '1' } })
    expect(await store.load()).toEqual({
      credentials: { sessdata: 's', biliJct: 'j', dedeUserId: '1' },
    })
  })

  it('returns defaults when stored bytes are not valid', async () => {
    await fs.writeFile(filePath, Buffer.from('not json', 'utf8'))
    const store = createStore({ filePath })
    expect(await store.load()).toEqual({ credentials: null })
  })
})
