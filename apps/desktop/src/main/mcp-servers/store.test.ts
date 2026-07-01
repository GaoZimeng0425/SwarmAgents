import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServerConfig } from '@swarm/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => {
      const s = b.toString('utf-8')
      if (!s.startsWith('enc:')) throw new Error('decrypt failed')
      return s.slice('enc:'.length)
    }),
  },
}))

import { createStore } from './store'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-store-'))
  path = join(dir, 'mcp-servers.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const cfg = (over: Partial<McpServerConfig> & Pick<McpServerConfig, 'name' | 'transport'>): McpServerConfig => ({
  id: over.name,
  enabled: true,
  ...over,
})

describe('mcp-servers store', () => {
  it('returns empty when neither .json nor legacy .enc exists', async () => {
    const state = await createStore({ filePath: path }).load()
    expect(state).toEqual({ servers: [] })
  })

  it('round-trips a config through save/load with name as id', async () => {
    const store = createStore({ filePath: path })
    await store.save({
      servers: [
        cfg({ name: 'workpanel', transport: 'http', url: 'http://127.0.0.1:8787/mcp' }),
        cfg({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server-fs', '/tmp'] }),
      ],
    })
    const { servers } = await store.load()
    expect(servers).toHaveLength(2)
    const wp = servers.find((s) => s.name === 'workpanel')!
    expect(wp.id).toBe('workpanel')
    expect(wp.transport).toBe('http')
    expect(servers.find((s) => s.name === 'fs')!.args).toEqual(['-y', 'server-fs', '/tmp'])
  })

  it('writes the Claude Code name-keyed shape and keeps secret refs literal', async () => {
    const store = createStore({ filePath: path })
    await store.save({
      servers: [
        cfg({
          name: 'workpanel',
          transport: 'http',
          url: 'http://127.0.0.1:8787/mcp',
          headers: { Authorization: 'Bearer ${WORKPANEL_TOKEN}' },
        }),
      ],
    })
    const raw = readFileSync(path, 'utf8')
    const json = JSON.parse(raw)
    expect(json.mcpServers.workpanel.type).toBe('http')
    // The ${VAR} reference must NOT be expanded at rest.
    expect(json.mcpServers.workpanel.headers.Authorization).toBe('Bearer ${WORKPANEL_TOKEN}')
    // enabled omitted when true (default) to keep the file clean.
    expect(json.mcpServers.workpanel.enabled).toBeUndefined()
  })

  it('persists enabled:false explicitly', async () => {
    const store = createStore({ filePath: path })
    await store.save({ servers: [cfg({ name: 'off', transport: 'http', url: 'http://x', enabled: false })] })
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.off.enabled).toBe(false)
  })

  it('reads a hand-written file: infers transport and accepts the transport alias', async () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          local: { command: 'node', args: ['s.js'] }, // no type → stdio
          remote: { url: 'http://h/mcp' }, // no type → http
          aliased: { transport: 'sse', url: 'http://h/sse' }, // `transport` alias
        },
      })
    )
    const { servers } = await createStore({ filePath: path }).load()
    expect(servers.find((s) => s.name === 'local')!.transport).toBe('stdio')
    expect(servers.find((s) => s.name === 'remote')!.transport).toBe('http')
    expect(servers.find((s) => s.name === 'aliased')!.transport).toBe('sse')
  })

  it('skips an invalid entry but keeps the valid ones', async () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          good: { url: 'http://h/mcp' },
          'bad name!': { url: 'http://h/mcp' }, // name fails the namespace regex
        },
      })
    )
    const { servers } = await createStore({ filePath: path }).load()
    expect(servers.map((s) => s.name)).toEqual(['good'])
  })

  it('recovers to empty (without clobbering) on invalid JSON', async () => {
    writeFileSync(path, '{ not valid json')
    const { servers } = await createStore({ filePath: path }).load()
    expect(servers).toEqual([])
    expect(existsSync(path)).toBe(true) // left for the user to fix
  })

  it('migrates a legacy encrypted .enc on first load', async () => {
    const encPath = join(dir, 'mcp-servers.enc')
    const legacy = {
      version: 1,
      servers: [{ id: '01ABC', name: 'workpanel', transport: 'http', url: 'http://h/mcp', enabled: true }],
    }
    writeFileSync(encPath, `enc:${JSON.stringify(legacy)}`)

    const { servers } = await createStore({ filePath: path }).load()
    expect(servers).toHaveLength(1)
    expect(servers[0].name).toBe('workpanel')
    expect(servers[0].id).toBe('workpanel') // ulid dropped; name is the id now
    // migration writes the plaintext file
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.workpanel.url).toBe('http://h/mcp')
  })
})
