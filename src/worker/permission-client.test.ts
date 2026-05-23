import type { Outbound } from '@shared/types/ipc'
import { describe, expect, it } from 'vitest'

import { createPermissionClient } from './permission-client'

describe('PermissionClient', () => {
  it('round-trips a request through send + resolve', async () => {
    const sent: Outbound[] = []
    const client = createPermissionClient((m) => sent.push(m))

    const pending = client.request({
      taskId: 't1',
      toolName: 'peekaboo.click',
      risk: 'medium',
      summary: 'click element',
      payload: { id: 'B12' },
    })

    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('permission.request')
    if (sent[0].type !== 'permission.request') throw new Error('unreachable')
    const actionId = sent[0].actionId

    client.resolve(actionId, 'grant')
    await expect(pending).resolves.toBe('grant')
  })

  it('ignores unknown actionId silently', () => {
    const client = createPermissionClient(() => {})
    // No throw expected.
    client.resolve('bogus-id', 'grant')
  })

  it('emits a unique actionId per request', () => {
    const sent: Outbound[] = []
    const client = createPermissionClient((m) => sent.push(m))
    client.request({
      taskId: 't1',
      toolName: 'a',
      risk: 'low',
      summary: 's',
      payload: {},
    })
    client.request({
      taskId: 't1',
      toolName: 'b',
      risk: 'low',
      summary: 's',
      payload: {},
    })
    const ids = sent
      .filter((m): m is Outbound & { type: 'permission.request' } => m.type === 'permission.request')
      .map((m) => m.actionId)
    expect(new Set(ids).size).toBe(2)
  })
})
