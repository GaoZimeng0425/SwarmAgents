import { describe, expect, it, vi } from 'vitest'

import { createPermissionRegistry } from './permission-registry'

describe('PermissionRegistry', () => {
  it('resolves a request through the caller-supplied actionId (request→resolve round-trip)', async () => {
    const registry = createPermissionRegistry()

    const actionId = 'act-1'
    const promise = registry.request({
      actionId,
      toolName: 'fs.write',
      risk: 'high',
      summary: 'Write to /etc/hosts',
      payload: {},
    })

    // The registry no longer broadcasts (run-hooks owns the permission_request
    // event); resolution correlates purely by the caller-supplied actionId.
    registry.resolve(actionId, 'grant')
    await expect(promise).resolves.toBe('grant')
  })

  it('ignores resolve for unknown actionId', () => {
    const registry = createPermissionRegistry()
    expect(() => registry.resolve('unknown', 'deny')).not.toThrow()
  })

  it('does not auto-resolve — waits indefinitely for an explicit decision', async () => {
    vi.useFakeTimers()
    const registry = createPermissionRegistry()

    const promise = registry.request({
      actionId: 'act-1',
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

  it('fail-safe denies when the run is aborted while pending', async () => {
    const ac = new AbortController()
    const registry = createPermissionRegistry()

    const promise = registry.request(
      { actionId: 'act-1', toolName: 'fs.write', risk: 'high', summary: 'test', payload: {} },
      ac.signal
    )

    ac.abort()
    await expect(promise).resolves.toBe('deny')
  })

  it('fail-safe denies without registering if the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const registry = createPermissionRegistry()

    await expect(
      registry.request(
        { actionId: 'act-1', toolName: 'fs.write', risk: 'high', summary: 'test', payload: {} },
        ac.signal
      )
    ).resolves.toBe('deny')
  })

  it('grant_always resolves the request as grant and auto-grants later same-tool requests', async () => {
    const registry = createPermissionRegistry()

    const first = registry.request({ actionId: 'a1', toolName: 'fs.write', risk: 'high', summary: 's', payload: {} })
    registry.resolve('a1', 'grant_always')
    // The gate only understands 'grant' — grant_always is translated.
    await expect(first).resolves.toBe('grant')

    // A later request for the SAME tool auto-grants with no new prompt.
    await expect(
      registry.request({ actionId: 'a2', toolName: 'fs.write', risk: 'high', summary: 's', payload: {} })
    ).resolves.toBe('grant')
  })

  it('grant_always is scoped per tool name — a different tool still waits for a decision', async () => {
    const registry = createPermissionRegistry()

    const first = registry.request({ actionId: 'a1', toolName: 'fs.write', risk: 'high', summary: 's', payload: {} })
    registry.resolve('a1', 'grant_always')
    await first

    const other = registry.request({ actionId: 'a2', toolName: 'shell.exec', risk: 'high', summary: 's', payload: {} })
    registry.resolve('a2', 'deny')
    await expect(other).resolves.toBe('deny')
  })
})
