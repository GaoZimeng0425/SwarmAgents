import type { McpServerConfig } from '@shared/types/mcp'
import { describe, expect, it, vi } from 'vitest'

import { mcpAddSpec } from './mcp'
import type { ToolRunContext } from './registry'

const baseCtx = (addMcpServer: ToolRunContext['addMcpServer']): ToolRunContext => ({
  sessionId: 's',
  taskId: 't',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  send: () => undefined,
  requestPermission: async () => 'grant',
  askUser: async () => '',
  addMcpServer,
})

const build = (add: ReturnType<typeof vi.fn>) => mcpAddSpec().build(baseCtx(add))

describe('mcp_add tool', () => {
  it('is high risk so the user confirms before an arbitrary command runs', () => {
    expect(mcpAddSpec().risk).toBe('high')
  })

  it('forwards a stdio server config and reports success', async () => {
    const add = vi.fn(async () => ({ ok: true, id: 'srv-1' }) as const)
    const res = await build(add).execute('1', {
      name: 'workpanel',
      transport: 'stdio',
      command: ' npx ',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'x' },
    })
    expect(add).toHaveBeenCalledWith({
      name: 'workpanel',
      transport: 'stdio',
      enabled: true,
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'x' },
      cwd: undefined,
    })
    expect((res.details as { id?: string }).id).toBe('srv-1')
    expect(res.content[0]).toMatchObject({ type: 'text' })
  })

  it('forwards a remote (http) server config with headers', async () => {
    const add = vi.fn(async () => ({ ok: true, id: 'srv-2' }) as const)
    await build(add).execute('1', {
      name: 'workpanel',
      transport: 'http',
      url: 'http://127.0.0.1:8787/mcp',
      headers: { Authorization: 'Bearer abc' },
    })
    expect(add).toHaveBeenCalledWith({
      name: 'workpanel',
      transport: 'http',
      enabled: true,
      url: 'http://127.0.0.1:8787/mcp',
      headers: { Authorization: 'Bearer abc' },
    })
  })

  it('throws when stdio has no command', async () => {
    const add = vi.fn()
    await expect(build(add).execute('1', { name: 'x', transport: 'stdio' })).rejects.toThrow(/command/)
    expect(add).not.toHaveBeenCalled()
  })

  it('throws when a remote server has no url', async () => {
    const add = vi.fn()
    await expect(build(add).execute('1', { name: 'x', transport: 'http' })).rejects.toThrow(/url/)
    expect(add).not.toHaveBeenCalled()
  })

  it('surfaces a persist/validation failure from Main as an error', async () => {
    const add = vi.fn(async () => ({ ok: false, code: 'duplicate_name', message: 'taken' }) as const)
    await expect(
      build(add).execute('1', { name: 'dup', transport: 'http', url: 'http://x' } satisfies Partial<McpServerConfig>)
    ).rejects.toThrow(/taken/)
  })
})
