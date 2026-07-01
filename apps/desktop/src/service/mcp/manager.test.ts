import type { McpServerConfig, McpServerStatus } from '@shared/types/mcp'
import { describe, expect, it, vi } from 'vitest'

import { createToolRegistry } from '../tools/registry'
import { createMcpManager, expandVars, type McpClientLike } from './manager'

function fakeClient(over: Partial<McpClientLike> = {}): McpClientLike {
  return {
    listTools: vi.fn().mockResolvedValue({
      tools: [{ name: 'search', description: 'search things', inputSchema: { type: 'object', properties: {} } }],
    }),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'hit' }] }),
    close: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

const stdio = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 's1',
  name: 'demo',
  transport: 'stdio',
  enabled: true,
  command: 'demo-server',
  ...over,
})

describe('expandVars', () => {
  const env = { TOK: 'secret', EMPTY: '' }
  it('expands ${VAR} from the env', () => {
    expect(expandVars('Bearer ${TOK}', env)).toBe('Bearer secret')
  })
  it('uses ${VAR:-default} when unset or empty', () => {
    expect(expandVars('${MISSING:-https://d}/mcp', env)).toBe('https://d/mcp')
    expect(expandVars('${EMPTY:-fallback}', env)).toBe('fallback')
  })
  it('expands an unset var with no default to empty string', () => {
    expect(expandVars('x${NOPE}y', env)).toBe('xy')
  })
  it('leaves text without refs untouched', () => {
    expect(expandVars('http://127.0.0.1:8787/mcp', env)).toBe('http://127.0.0.1:8787/mcp')
  })
})

describe('createMcpManager', () => {
  it('connects a server, registers namespaced tools, and emits connected status', async () => {
    const registry = createToolRegistry()
    const statuses: McpServerStatus[][] = []
    const client = fakeClient()
    const mgr = createMcpManager({
      toolRegistry: registry,
      emitStatus: (s) => statuses.push(s),
      connect: async () => client,
    })

    await mgr.setServers([stdio()])

    const specs = registry.list().filter((s) => s.source === 'mcp')
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({ group: 'demo', name: 'demo__search', risk: 'medium' })

    const final = statuses.at(-1)!
    expect(final[0]).toMatchObject({ id: 's1', state: 'connected' })
    expect(final[0].tools).toEqual([{ name: 'search', description: 'search things', risk: 'medium', enabled: true }])
  })

  it('a registered MCP tool calls through to client.callTool and maps text content', async () => {
    const registry = createToolRegistry()
    const client = fakeClient()
    const mgr = createMcpManager({ toolRegistry: registry, emitStatus: vi.fn(), connect: async () => client })
    await mgr.setServers([stdio()])

    const { tools } = registry.resolve(['demo.*'], {
      taskId: 't',
      spawnChild: vi.fn(),
      send: vi.fn(),
      requestPermission: vi.fn(),
    } as never)
    const result = await tools[0].execute('call-1', { q: 'x' })
    expect(client.callTool).toHaveBeenCalledWith({ name: 'search', arguments: { q: 'x' } })
    expect(result.content).toEqual([{ type: 'text', text: 'hit' }])
  })

  it('throws when the MCP tool result is an error', async () => {
    const registry = createToolRegistry()
    const client = fakeClient({
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    })
    const mgr = createMcpManager({ toolRegistry: registry, emitStatus: vi.fn(), connect: async () => client })
    await mgr.setServers([stdio()])
    const { tools } = registry.resolve(['demo.*'], {
      taskId: 't',
      spawnChild: vi.fn(),
      send: vi.fn(),
      requestPermission: vi.fn(),
    } as never)
    await expect(tools[0].execute('c', {})).rejects.toThrow('boom')
  })

  it('honors per-tool overrides (disabled tool not registered, risk overridden)', async () => {
    const registry = createToolRegistry()
    const client = fakeClient({
      listTools: vi.fn().mockResolvedValue({
        tools: [
          { name: 'search', inputSchema: { type: 'object' } },
          { name: 'danger', inputSchema: { type: 'object' } },
        ],
      }),
    })
    const mgr = createMcpManager({ toolRegistry: registry, emitStatus: vi.fn(), connect: async () => client })
    await mgr.setServers([
      stdio({ toolOverrides: { danger: { enabled: false }, search: { enabled: true, risk: 'low' } } }),
    ])

    const specs = registry.list().filter((s) => s.source === 'mcp')
    expect(specs.map((s) => s.name)).toEqual(['demo__search'])
    expect(specs[0].risk).toBe('low')
  })

  it('tears down tools and closes the client when a server is removed', async () => {
    const registry = createToolRegistry()
    const client = fakeClient()
    const mgr = createMcpManager({ toolRegistry: registry, emitStatus: vi.fn(), connect: async () => client })
    await mgr.setServers([stdio()])
    expect(registry.list().filter((s) => s.source === 'mcp')).toHaveLength(1)

    await mgr.setServers([])
    expect(registry.list().filter((s) => s.source === 'mcp')).toHaveLength(0)
    expect(client.close).toHaveBeenCalled()
    expect(mgr.getStatus()).toEqual([])
  })

  it('reports error status when connect fails', async () => {
    const registry = createToolRegistry()
    const mgr = createMcpManager({
      toolRegistry: registry,
      emitStatus: vi.fn(),
      connect: async () => {
        throw new Error('spawn failed')
      },
    })
    await mgr.setServers([stdio()])
    const status = mgr.getStatus()[0]
    expect(status).toMatchObject({ id: 's1', state: 'error' })
    expect(status.error).toContain('spawn failed')
  })

  it('marks disabled servers idle without connecting', async () => {
    const registry = createToolRegistry()
    const connect = vi.fn()
    const mgr = createMcpManager({ toolRegistry: registry, emitStatus: vi.fn(), connect })
    await mgr.setServers([stdio({ enabled: false })])
    expect(connect).not.toHaveBeenCalled()
    expect(mgr.getStatus()[0]).toMatchObject({ id: 's1', state: 'idle' })
  })
})
