import { describe, expect, it, vi } from 'vitest'

import { createPermissionRegistry } from './permission-registry'

describe('PermissionRegistry', () => {
  it('broadcasts run.permission_request on request and resolves on decision', async () => {
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
    expect(event).toBe('message.permission_request')
    expect(data.actionId).toBeTruthy()

    registry.resolve(data.actionId, 'grant')
    await expect(promise).resolves.toBe('grant')
  })

  it('ignores resolve for unknown actionId', () => {
    const registry = createPermissionRegistry(vi.fn())
    expect(() => registry.resolve('unknown', 'deny')).not.toThrow()
  })

  it('does not auto-resolve — waits indefinitely for an explicit decision', async () => {
    vi.useFakeTimers()
    const registry = createPermissionRegistry(vi.fn())

    const promise = registry.request({
      taskId: 'task-1',
      toolName: 'fs.write',
      risk: 'high',
      summary: 'test',
      payload: {},
    })

    // No timer should ever auto-resolve this; even an hour later it stays pending.
    vi.advanceTimersByTime(60 * 60_000)
    const race = await Promise.race([promise.then(() => 'settled'), Promise.resolve('pending')])
    expect(race).toBe('pending')
    vi.useRealTimers()
  })

  it('fail-safe denies when the task is aborted while pending', async () => {
    const ac = new AbortController()
    const registry = createPermissionRegistry(vi.fn())

    const promise = registry.request(
      { taskId: 'task-1', toolName: 'fs.write', risk: 'high', summary: 'test', payload: {} },
      ac.signal
    )

    ac.abort()
    await expect(promise).resolves.toBe('deny')
  })

  it('fail-safe denies without prompting if the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const broadcast = vi.fn()
    const registry = createPermissionRegistry(broadcast)

    await expect(
      registry.request(
        { taskId: 'task-1', toolName: 'fs.write', risk: 'high', summary: 'test', payload: {} },
        ac.signal
      )
    ).resolves.toBe('deny')
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('grant_always resolves the request as grant and auto-grants later same-tool requests', async () => {
    const broadcast = vi.fn()
    const registry = createPermissionRegistry(broadcast)

    const first = registry.request({ taskId: 't1', toolName: 'fs.write', risk: 'high', summary: 's', payload: {} })
    const [, data] = broadcast.mock.calls[0] as [string, { actionId: string }]
    registry.resolve(data.actionId, 'grant_always')
    // The engine only understands 'grant' — grant_always is translated.
    await expect(first).resolves.toBe('grant')

    // A later request for the SAME tool auto-grants with no new prompt.
    broadcast.mockClear()
    await expect(
      registry.request({ taskId: 't2', toolName: 'fs.write', risk: 'high', summary: 's', payload: {} })
    ).resolves.toBe('grant')
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('grant_always is scoped per tool name — a different tool still prompts', async () => {
    const broadcast = vi.fn()
    const registry = createPermissionRegistry(broadcast)

    const first = registry.request({ taskId: 't1', toolName: 'fs.write', risk: 'high', summary: 's', payload: {} })
    const [, data] = broadcast.mock.calls[0] as [string, { actionId: string }]
    registry.resolve(data.actionId, 'grant_always')
    await first

    broadcast.mockClear()
    const other = registry.request({ taskId: 't2', toolName: 'shell.exec', risk: 'high', summary: 's', payload: {} })
    expect(broadcast).toHaveBeenCalledOnce() // not auto-granted; a prompt is broadcast
    const [, d2] = broadcast.mock.calls[0] as [string, { actionId: string }]
    registry.resolve(d2.actionId, 'deny')
    await expect(other).resolves.toBe('deny')
  })
})
