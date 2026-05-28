import { describe, it, expect, vi } from 'vitest'
import { createPermissionRegistry } from './permission-registry'

describe('PermissionRegistry', () => {
  it('broadcasts SSE event on request and resolves on decision', async () => {
    const broadcast = vi.fn()
    const registry = createPermissionRegistry(broadcast)

    const promise = registry.request({
      taskId: 'task-1',
      toolName: 'fs.write',
      risk: 'high',
      summary: 'Write to /etc/hosts',
      payload: {},
    })

    expect(broadcast).toHaveBeenCalledOnce()
    const [event, data] = broadcast.mock.calls[0] as [string, { actionId: string }]
    expect(event).toBe('task.permission_request')
    expect(data.actionId).toBeTruthy()

    registry.resolve(data.actionId, 'grant')
    await expect(promise).resolves.toBe('grant')
  })

  it('ignores resolve for unknown actionId', () => {
    const registry = createPermissionRegistry(vi.fn())
    expect(() => registry.resolve('unknown', 'deny')).not.toThrow()
  })

  it('auto-denies after 30s timeout', async () => {
    vi.useFakeTimers()
    const broadcast = vi.fn()
    const registry = createPermissionRegistry(broadcast)

    const promise = registry.request({
      taskId: 'task-1',
      toolName: 'fs.write',
      risk: 'high',
      summary: 'test',
      payload: {},
    })

    vi.advanceTimersByTime(30_001)
    await expect(promise).resolves.toBe('deny')
    vi.useRealTimers()
  })
})
