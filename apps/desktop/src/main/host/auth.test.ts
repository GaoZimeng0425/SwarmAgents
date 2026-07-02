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

  it('loadOrCreateHostConfig honors SWARM_WS_HOST_PORT when creating', () => {
    const prev = process.env.SWARM_WS_HOST_PORT
    process.env.SWARM_WS_HOST_PORT = '47877'
    try {
      expect(loadOrCreateHostConfig(dir).port).toBe(47877)
    } finally {
      if (prev === undefined) delete process.env.SWARM_WS_HOST_PORT
      else process.env.SWARM_WS_HOST_PORT = prev
    }
  })

  it('loadOrCreateHostConfig falls back to default port when env unset', () => {
    const prev = process.env.SWARM_WS_HOST_PORT
    delete process.env.SWARM_WS_HOST_PORT
    try {
      expect(loadOrCreateHostConfig(dir).port).toBe(47777)
    } finally {
      if (prev !== undefined) process.env.SWARM_WS_HOST_PORT = prev
    }
  })

  it('loadOrCreateHostConfig ignores invalid SWARM_WS_HOST_PORT', () => {
    const prev = process.env.SWARM_WS_HOST_PORT
    try {
      for (const v of ['not-a-port', '0', '70000', '-1']) {
        process.env.SWARM_WS_HOST_PORT = v
        const d = mkdtempSync(join(tmpdir(), 'ws-host-'))
        try {
          expect(loadOrCreateHostConfig(d).port).toBe(47777)
        } finally {
          rmSync(d, { recursive: true, force: true })
        }
      }
    } finally {
      if (prev === undefined) delete process.env.SWARM_WS_HOST_PORT
      else process.env.SWARM_WS_HOST_PORT = prev
    }
  })
})
