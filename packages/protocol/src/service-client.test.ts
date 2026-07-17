import { describe, expect, it } from 'vitest'

import { createServiceClient } from './service-client'
import { serviceMethodArgSchemas } from './service-methods'

type Sent = { kind: string; id: string; method: string; args: unknown[] }

function fakeTransport() {
  const sent: Sent[] = []
  let listener: ((m: unknown) => void) | null = null
  return {
    sent,
    emit: (m: unknown) => listener?.(m),
    transport: {
      postMessage: (m: unknown) => sent.push(m as Sent),
      on: (_c: 'message', l: (m: unknown) => void) => {
        listener = l
      },
      off: () => {
        listener = null
      },
    },
  }
}

describe('createServiceClient (generated)', () => {
  it('exposes one function per table method', () => {
    const { transport } = fakeTransport()
    const client = createServiceClient({ transport }) as unknown as Record<string, unknown>
    for (const m of Object.keys(serviceMethodArgSchemas)) {
      expect(typeof client[m], m).toBe('function')
    }
  })

  it('sends the table method name and raw args on the wire, resolves on response', async () => {
    const ft = fakeTransport()
    const client = createServiceClient({ transport: ft.transport })
    await client.connect()
    const p = client.renameSession('s1', 'new title')
    expect(ft.sent).toHaveLength(1)
    expect(ft.sent[0]).toMatchObject({ kind: 'request', method: 'renameSession', args: ['s1', 'new title'] })
    ft.emit({ kind: 'response', id: ft.sent[0].id, ok: true, result: { ok: true } })
    await expect(p).resolves.toEqual({ ok: true })
  })

  it('omits trailing optionals from the wire args (short array)', async () => {
    const ft = fakeTransport()
    const client = createServiceClient({ transport: ft.transport })
    await client.connect()
    void client.getSessionEntries('s1')
    expect(ft.sent[0]).toMatchObject({ method: 'getSessionEntries', args: ['s1'] })
  })

  it('rejects the pending call on an error response', async () => {
    const ft = fakeTransport()
    const client = createServiceClient({ transport: ft.transport })
    await client.connect()
    const p = client.listSessions()
    ft.emit({ kind: 'response', id: ft.sent[0].id, ok: false, error: 'boom' })
    await expect(p).rejects.toThrow('boom')
  })
})
