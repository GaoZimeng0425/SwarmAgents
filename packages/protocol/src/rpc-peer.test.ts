import { describe, expect, it, vi } from 'vitest'

import { createRpcPeer } from './rpc-peer'

function fakeTransport() {
  const listeners = new Set<(m: unknown) => void>()
  const posted: unknown[] = []
  return {
    posted,
    postMessage(m: unknown) {
      posted.push(m)
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
}

// Drain microtasks until the request -> response promise chain resolves. The
// handler runs inside a Promise.resolve().then(...).then(...) chain, and async
// handlers add their own ticks, so a single await is not enough. Mirrors the
// flush() helper in service-client.mainrpc.test.ts for the same reason.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve()
  }
}

describe('createRpcPeer', () => {
  it('call() posts a request and resolves on the matching response', async () => {
    const t = fakeTransport()
    const peer = createRpcPeer({ transport: t })
    await peer.connect()
    const p = peer.call('listAgents', [])
    const req = t.posted.at(-1) as { kind: string; id: string; method: string }
    expect(req).toMatchObject({ kind: 'request', method: 'listAgents' })
    t.fire({ kind: 'response', id: req.id, ok: true, result: ['ceo'] })
    await expect(p).resolves.toEqual(['ceo'])
  })

  it('call() rejects on an ok:false response', async () => {
    const t = fakeTransport()
    const peer = createRpcPeer({ transport: t })
    await peer.connect()
    const p = peer.call('submitGoal', ['s1', 'go'])
    const req = t.posted.at(-1) as { id: string }
    t.fire({ kind: 'response', id: req.id, ok: false, error: 'boom' })
    await expect(p).rejects.toThrow('boom')
  })

  it('dispatches an incoming request to a registered handler and posts the result', async () => {
    const t = fakeTransport()
    const peer = createRpcPeer({ transport: t })
    await peer.connect()
    const handler = vi.fn(async (a: number, b: number) => a + b)
    peer.registerHandler('add', handler as (...args: unknown[]) => Promise<unknown>)

    t.fire({ kind: 'request', id: 'x:1', method: 'add', args: [2, 3] })
    await flush()

    expect(handler).toHaveBeenCalledWith(2, 3)
    expect(t.posted).toContainEqual({ kind: 'response', id: 'x:1', ok: true, result: 5 })
  })

  it('falls back to defaultHandler when no per-method handler is registered', async () => {
    const t = fakeTransport()
    const defaultHandler = vi.fn(async (method: string, args: unknown[]) => ({ method, args }))
    const peer = createRpcPeer({ transport: t, defaultHandler })
    await peer.connect()

    t.fire({ kind: 'request', id: 'x:1', method: 'anything', args: [1] })
    await flush()

    expect(defaultHandler).toHaveBeenCalledWith('anything', [1], 'x:1')
    expect(t.posted).toContainEqual({
      kind: 'response',
      id: 'x:1',
      ok: true,
      result: { method: 'anything', args: [1] },
    })
  })

  it('posts an error response when neither a handler nor defaultHandler exists', async () => {
    const t = fakeTransport()
    const peer = createRpcPeer({ transport: t })
    await peer.connect()

    t.fire({ kind: 'request', id: 'x:1', method: 'ghost', args: [] })
    await flush()

    expect(t.posted).toContainEqual({ kind: 'response', id: 'x:1', ok: false, error: 'no handler for ghost' })
  })

  it('forwards event messages to onEvent', async () => {
    const t = fakeTransport()
    const received: Array<{ e: string; d: unknown }> = []
    const peer = createRpcPeer({ transport: t, onEvent: (e, d) => received.push({ e, d }) })
    await peer.connect()
    t.fire({ kind: 'event', event: 'run.progress', data: { runId: 'r1' } })
    expect(received).toEqual([{ e: 'run.progress', d: { runId: 'r1' } }])
  })

  it('two peers sharing one transport never collide on id even from 1', async () => {
    const t = fakeTransport()
    const peerA = createRpcPeer({ transport: t })
    const peerB = createRpcPeer({ transport: t })
    await peerA.connect()
    await peerB.connect()
    const pA = peerA.call('m', [])
    const pB = peerB.call('m', [])
    const idA = (t.posted[0] as { id: string }).id
    const idB = (t.posted[1] as { id: string }).id
    expect(idA).not.toBe(idB)
    t.fire({ kind: 'response', id: idA, ok: true, result: 'A' })
    t.fire({ kind: 'response', id: idB, ok: true, result: 'B' })
    await expect(pA).resolves.toBe('A')
    await expect(pB).resolves.toBe('B')
  })
})
