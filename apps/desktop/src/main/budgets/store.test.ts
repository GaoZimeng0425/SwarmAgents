import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultBudgetConfig } from '@swarm/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createStore } from './store'

describe('budgets store', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarm-budgets-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns defaults when the file is missing', async () => {
    const store = createStore({ filePath: join(dir, 'budgets.json') })
    expect(await store.load()).toEqual(defaultBudgetConfig())
  })

  it('round-trips a saved config', async () => {
    const store = createStore({ filePath: join(dir, 'budgets.json') })
    const config = { ...defaultBudgetConfig(), main: { tokens: 12, calls: 3, wallMs: 1000, usdCents: 50 } }
    await store.save(config)
    expect(await createStore({ filePath: join(dir, 'budgets.json') }).load()).toEqual(config)
  })

  it('falls back to defaults on a corrupt file', async () => {
    const filePath = join(dir, 'budgets.json')
    writeFileSync(filePath, '{ not json')
    expect(await createStore({ filePath }).load()).toEqual(defaultBudgetConfig())
  })
})
