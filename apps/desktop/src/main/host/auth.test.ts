import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { generateToken, loadOrCreateHostConfig } from './auth'

describe('ws host auth', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-host-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('generateToken returns 32-byte hex', () => {
    const t = generateToken()
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(generateToken()).not.toBe(t)
  })

  it('loadOrCreateHostConfig creates ws-host.json on first call', () => {
    const cfg = loadOrCreateHostConfig(dir)
    expect(cfg.port).toBeGreaterThan(1024)
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/)
    const onDisk = JSON.parse(readFileSync(join(dir, 'ws-host.json'), 'utf8'))
    expect(onDisk).toEqual({ port: cfg.port, token: cfg.token })
  })

  it('loadOrCreateHostConfig reuses existing port+token', () => {
    const first = loadOrCreateHostConfig(dir)
    const second = loadOrCreateHostConfig(dir)
    expect(second).toEqual(first)
  })
})
