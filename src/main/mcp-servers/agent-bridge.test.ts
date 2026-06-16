import { describe, expect, it, vi } from 'vitest'

import { applyAgentMcpAdd } from './agent-bridge'
import type { Service } from './service'

const fakeService = (add: ReturnType<typeof vi.fn>): Service => ({ add }) as unknown as Service

describe('applyAgentMcpAdd', () => {
  it('validates + persists a valid config and returns its result with the requestId', async () => {
    const add = vi.fn(async () => ({ ok: true, id: 'srv-1' }))
    const out = await applyAgentMcpAdd(fakeService(add), {
      requestId: 'req-1',
      config: { name: 'workpanel', transport: 'http', enabled: true, url: 'http://127.0.0.1:8787/mcp' },
    })
    expect(out).toEqual({ requestId: 'req-1', result: { ok: true, id: 'srv-1' } })
    expect(add).toHaveBeenCalledOnce()
  })

  it('rejects an invalid config without touching the store', async () => {
    const add = vi.fn()
    const out = await applyAgentMcpAdd(fakeService(add), {
      requestId: 'req-2',
      config: { name: 'bad name!', transport: 'http', enabled: true, url: 'http://x' },
    })
    expect(out?.result.ok).toBe(false)
    expect(add).not.toHaveBeenCalled()
  })

  it('returns null for a malformed event', async () => {
    const add = vi.fn()
    expect(await applyAgentMcpAdd(fakeService(add), { nope: true })).toBeNull()
    expect(add).not.toHaveBeenCalled()
  })
})
