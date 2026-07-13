import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createStore } from './store'

let dir: string
let filePath: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'bili-store-'))
  filePath = join(dir, 'bilibili.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('bilibili store', () => {
  it('returns defaults when file is missing', async () => {
    const store = createStore({ filePath })
    expect(await store.load()).toEqual({ credentials: null, obsidian: null, transcription: null })
  })

  it('round-trips saved credentials', async () => {
    const store = createStore({ filePath })
    await store.save({
      credentials: { sessdata: 's', biliJct: 'j', dedeUserId: '1' },
      obsidian: null,
      transcription: null,
    })
    expect(await store.load()).toEqual({
      credentials: { sessdata: 's', biliJct: 'j', dedeUserId: '1' },
      obsidian: null,
      transcription: null,
    })
  })

  it('returns defaults when stored bytes are not valid', async () => {
    await fs.writeFile(filePath, 'not json')
    const store = createStore({ filePath })
    expect(await store.load()).toEqual({ credentials: null, obsidian: null, transcription: null })
  })
})
