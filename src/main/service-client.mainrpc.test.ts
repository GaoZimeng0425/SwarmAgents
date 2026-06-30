import { describe, expect, it } from 'vitest'
import { createServiceClient, type ServiceTransport } from './service-client'

function fakeTransport(): { t: ServiceTransport; sent: unknown[]; deliver(m: unknown): void } {
  const sent: unknown[] = []
  let listener: ((m: unknown) => void) | null = null
  return {
    sent,
    t: {
      postMessage: (m: unknown) => sent.push(m),
      on: (_c: 'message', l: (m: unknown) => void) => {
        listener = l
      },
      off: () => {
        listener = null
      },
    } as unknown as ServiceTransport,
    deliver(m: unknown) {
      listener?.(m)
    },
  }
}

// Drain microtasks until the mainRequest -> mainResponse promise chain resolves.
// The handler runs inside a Promise.resolve().then(...).then(...) chain, and async
// handlers add their own ticks, so a single await is not enough.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve()
  }
}

describe('service-client mainRequest routing', () => {
  it('routes mainRequest to a registered handler and posts mainResponse', async () => {
    const { t, sent, deliver } = fakeTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    client.registerMainRpc('gmail.search', async (q, limit) => [{ id: 't1', q, limit }])

    deliver({ kind: 'mainRequest', id: 77, method: 'gmail.search', args: ['inv', 5] })
    await flush()

    expect(sent).toEqual([
      { kind: 'mainResponse', id: 77, ok: true, result: [{ id: 't1', q: 'inv', limit: 5 }] },
    ])
  })

  it('posts an error response when the handler throws', async () => {
    const { t, sent, deliver } = fakeTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    client.registerMainRpc('gmail.get_thread', async () => {
      throw new Error('boom')
    })

    deliver({ kind: 'mainRequest', id: 9, method: 'gmail.get_thread', args: ['x'] })
    await flush()

    expect(sent).toEqual([{ kind: 'mainResponse', id: 9, ok: false, error: 'boom' }])
  })

  it('warns on mainRequest with no handler', async () => {
    const { t, sent, deliver } = fakeTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    deliver({ kind: 'mainRequest', id: 3, method: 'gmail.list_recent', args: [] })
    await flush()
    // No handler registered → error response, not a crash.
    expect(sent).toEqual([
      { kind: 'mainResponse', id: 3, ok: false, error: expect.stringContaining('no handler') },
    ])
  })
})
