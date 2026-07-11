import { afterEach, describe, expect, it, vi } from 'vitest'

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

// Drain microtasks until the request -> response promise chain resolves. The
// handler runs inside a Promise.resolve().then(...).then(...) chain, and
// async handlers add their own ticks, so a single await is not enough.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve()
  }
}

describe('service-client registerHandler routing', () => {
  it('routes an incoming request to a registered handler and posts a response', async () => {
    const { t, sent, deliver } = fakeTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    client.registerHandler('gmail.search', async (q, limit) => [{ id: 't1', q, limit }])

    deliver({ kind: 'request', id: 'peer-1:77', method: 'gmail.search', args: ['inv', 5] })
    await flush()

    expect(sent).toEqual([{ kind: 'response', id: 'peer-1:77', ok: true, result: [{ id: 't1', q: 'inv', limit: 5 }] }])
  })

  it('posts an error response when the handler throws', async () => {
    const { t, sent, deliver } = fakeTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    client.registerHandler('gmail.get_thread', async () => {
      throw new Error('boom')
    })

    deliver({ kind: 'request', id: 'peer-1:9', method: 'gmail.get_thread', args: ['x'] })
    await flush()

    expect(sent).toEqual([{ kind: 'response', id: 'peer-1:9', ok: false, error: 'boom' }])
  })

  it('posts an error response for a request with no registered handler', async () => {
    const { t, sent, deliver } = fakeTransport()
    const client = createServiceClient({ transport: t })
    await client.connect()
    deliver({ kind: 'request', id: 'peer-1:3', method: 'gmail.list_recent', args: [] })
    await flush()
    expect(sent).toEqual([
      { kind: 'response', id: 'peer-1:3', ok: false, error: expect.stringContaining('no handler') },
    ])
  })

  describe('no-handler logging', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('warns on a request with no registered handler so the miss is visible in logs', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { t, deliver } = fakeTransport()
      const client = createServiceClient({ transport: t })
      await client.connect()

      deliver({ kind: 'request', id: 'peer-1:3', method: 'gmail.list_recent', args: [] })
      await flush()

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'no rpc handler', method: 'gmail.list_recent', id: 'peer-1:3' })
      )
    })
  })
})
