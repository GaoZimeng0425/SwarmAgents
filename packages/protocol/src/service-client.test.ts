import { describe, expect, it } from 'vitest'

import { createServiceClient, type ServiceTransport } from './service-client'

function mockTransport() {
  const listeners = new Set<(m: unknown) => void>()
  const posted: Array<{ kind: string; id: string; method: string; args: unknown[] }> = []
  const t = {
    posted,
    postMessage(m: unknown) {
      posted.push(m as (typeof posted)[number])
    },
    on(_c: 'message', l: (m: unknown) => void) {
      listeners.add(l)
    },
    off(_c: 'message', l: (m: unknown) => void) {
      listeners.delete(l)
    },
    fire(m: unknown) {
      for (const l of listeners) l(m)
    },
  }
  return t as ServiceTransport & typeof t
}

describe('ServiceClient', () => {
  it('createSession posts a request and resolves with the response result', async () => {
    const t = mockTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    const p = client.createSession({
      id: 'anthropic',
      registry: 'anthropic',
      apiStyle: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
    })
    const req = t.posted.at(-1)!
    expect(req).toMatchObject({ kind: 'request', method: 'createSession' })
    t.fire({ kind: 'response', id: req.id, ok: true, result: { sessionId: 'ses-42' } })
    expect((await p).sessionId).toBe('ses-42')
  })

  it('rejects when the service returns ok:false', async () => {
    const t = mockTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    const p = client.submitPrompt('ses-1', 'go')
    const req = t.posted.at(-1)!
    t.fire({ kind: 'response', id: req.id, ok: false, error: 'boom' })
    await expect(p).rejects.toThrow('boom')
  })

  it('forwards events to onEvent', async () => {
    const received: Array<{ e: string; d: unknown }> = []
    const t = mockTransport()
    const client = createServiceClient({ transport: t, onEvent: (e, d) => received.push({ e, d }) })
    await client.connect()
    t.fire({ kind: 'event', event: 'demo.complete', data: { runId: 'x' } })
    expect(received).toEqual([{ e: 'demo.complete', d: { runId: 'x' } }])
  })

  it('stops forwarding after disconnect', async () => {
    const received: unknown[] = []
    const t = mockTransport()
    const client = createServiceClient({ transport: t, onEvent: (e, d) => received.push({ e, d }) })
    await client.connect()
    client.disconnect()
    t.fire({ kind: 'event', event: 'demo.progress', data: {} })
    expect(received).toHaveLength(0)
  })
})
