import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

import { attachBridge, createConnRegistry } from './bridge'

// A fake service transport: structured like the Electron utilityProcess —
// postMessage + EventEmitter 'message'. The host's main serviceClient uses the
// same shape, so a peer sharing it sees the same traffic.
function fakeServiceTransport() {
  const bus = new EventEmitter()
  return {
    postMessage: (m: unknown) => bus.emit('message', m),
    on: (_ch: 'message', fn: (m: unknown) => void) => bus.on('message', fn),
    off: (_ch: 'message', fn: (m: unknown) => void) => bus.off('message', fn),
    emit: (m: unknown) => bus.emit('message', m), // test hook to simulate service→main
  }
}

async function connectPeer(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
  })
  return ws
}

describe('ws bridge', () => {
  let server: WebSocketServer
  let port: number
  beforeEach(async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((res) => server.once('listening', res))
    port = (server.address() as { port: number }).port
  })
  afterEach(() => server.close())

  it('relays a peer request to the service transport', async () => {
    const svc = fakeServiceTransport()
    const received: unknown[] = []
    svc.on('message', (m) => received.push(m))
    const registry = createConnRegistry()
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc as never, log: console, registry }))

    const ws = await connectPeer(port)
    ws.send(JSON.stringify({ kind: 'request', id: 'peerA:1', method: 'listAgents', args: [] }))
    await new Promise((res) => setTimeout(res, 50))
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ kind: 'request', id: 'peerA:1', method: 'listAgents' })
    ws.close()
  })

  it('routes a response only to the peer that claimed its connId', async () => {
    const svc = fakeServiceTransport()
    const registry = createConnRegistry()
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc as never, log: console, registry }))

    const peerA = await connectPeer(port)
    const peerB = await connectPeer(port)
    const seenA: unknown[] = []
    const seenB: unknown[] = []
    peerA.on('message', (raw) => seenA.push(JSON.parse(raw.toString())))
    peerB.on('message', (raw) => seenB.push(JSON.parse(raw.toString())))

    // Only peerA asks — this is what claims connId "peerA" for peerA.
    peerA.send(JSON.stringify({ kind: 'request', id: 'peerA:1', method: 'listAgents', args: [] }))
    await new Promise((res) => setTimeout(res, 50))

    svc.emit({ kind: 'response', id: 'peerA:1', ok: true, result: { agents: [] } })
    await new Promise((res) => setTimeout(res, 50))

    expect(seenA).toEqual([{ kind: 'response', id: 'peerA:1', ok: true, result: { agents: [] } }])
    expect(seenB).toHaveLength(0)
    peerA.close()
    peerB.close()
  })

  it('broadcasts an event to every connected peer', async () => {
    const svc = fakeServiceTransport()
    const registry = createConnRegistry()
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc as never, log: console, registry }))

    const peerA = await connectPeer(port)
    const peerB = await connectPeer(port)
    const seenA: unknown[] = []
    const seenB: unknown[] = []
    peerA.on('message', (raw) => seenA.push(JSON.parse(raw.toString())))
    peerB.on('message', (raw) => seenB.push(JSON.parse(raw.toString())))

    svc.emit({ kind: 'event', event: 'run.progress', data: { runId: 'r1' } })
    await new Promise((res) => setTimeout(res, 50))

    expect(seenA).toEqual([{ kind: 'event', event: 'run.progress', data: { runId: 'r1' } }])
    expect(seenB).toEqual([{ kind: 'event', event: 'run.progress', data: { runId: 'r1' } }])
    peerA.close()
    peerB.close()
  })

  it('never forwards a request the service itself emits (a main-only call) to any peer', async () => {
    // Regression: gmail.*/calendar.*/weather.* calls are the service asking
    // main directly — main answers via its own listener on the same
    // transport, never via the bridge. No peer ever claimed this id, so it
    // must never be delivered to anyone.
    const svc = fakeServiceTransport()
    const registry = createConnRegistry()
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc as never, log: console, registry }))

    const peer = await connectPeer(port)
    const seen: unknown[] = []
    peer.on('message', (raw) => seen.push(JSON.parse(raw.toString())))

    svc.emit({ kind: 'request', id: 'service:1', method: 'weather.get_forecast', args: [null, null] })
    await new Promise((res) => setTimeout(res, 50))

    expect(seen).toHaveLength(0)
    peer.close()
  })

  it('never forwards a response for an id no connected peer claimed', async () => {
    const svc = fakeServiceTransport()
    const registry = createConnRegistry()
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc as never, log: console, registry }))

    const peer = await connectPeer(port)
    const seen: unknown[] = []
    peer.on('message', (raw) => seen.push(JSON.parse(raw.toString())))

    // This peer never sent a request with this id — e.g. it answers main's
    // own submitPrompt call, made directly against the service, not via this peer.
    svc.emit({ kind: 'response', id: 'main-conn:1', ok: true, result: { runId: 'r1' } })
    await new Promise((res) => setTimeout(res, 50))

    expect(seen).toHaveLength(0)
    peer.close()
  })

  it('drops (and warns about) a request whose id has no connId prefix — its response could never route back', async () => {
    const svc = fakeServiceTransport()
    const received: unknown[] = []
    svc.on('message', (m) => received.push(m))
    const registry = createConnRegistry()
    const warns: unknown[] = []
    const log = { info: () => {}, warn: (m: unknown) => warns.push(m), error: () => {} }
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc as never, log, registry }))

    const peer = await connectPeer(port)
    peer.send(JSON.stringify({ kind: 'request', id: 'bare-id-no-colon', method: 'listAgents', args: [] }))
    await new Promise((res) => setTimeout(res, 50))

    expect(received).toHaveLength(0)
    expect(warns).toHaveLength(1)
    peer.close()
  })

  it('drops (and warns about) a request whose connId is already claimed by a different live peer — no response hijacking', async () => {
    const svc = fakeServiceTransport()
    const received: unknown[] = []
    svc.on('message', (m) => received.push(m))
    const registry = createConnRegistry()
    const warns: unknown[] = []
    const log = { info: () => {}, warn: (m: unknown) => warns.push(m), error: () => {} }
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc as never, log, registry }))

    const peerA = await connectPeer(port)
    const peerB = await connectPeer(port)
    peerA.send(JSON.stringify({ kind: 'request', id: 'peerA:1', method: 'listAgents', args: [] }))
    await new Promise((res) => setTimeout(res, 50))
    const ownerAfterA = registry.ownerOf('peerA')

    // peerB tries to take over peerA's connId to have peerA's responses
    // routed to itself. The request must be dropped and the claim unchanged.
    peerB.send(JSON.stringify({ kind: 'request', id: 'peerA:99', method: 'listSessions', args: [] }))
    await new Promise((res) => setTimeout(res, 50))

    expect(received).toHaveLength(1) // only peerA's original request went through
    expect(warns).toHaveLength(1)
    expect(registry.ownerOf('peerA')).toBe(ownerAfterA)
    peerA.close()
    peerB.close()
  })

  it('lets a reconnecting peer reuse its connId once the previous socket is gone', async () => {
    const svc = fakeServiceTransport()
    const received: unknown[] = []
    svc.on('message', (m) => received.push(m))
    const registry = createConnRegistry()
    server.on('connection', (ws) => {
      const detach = attachBridge({ peer: ws, service: svc as never, log: console, registry })
      ws.on('close', () => detach())
    })

    const first = await connectPeer(port)
    first.send(JSON.stringify({ kind: 'request', id: 'peerA:1', method: 'listAgents', args: [] }))
    await new Promise((res) => setTimeout(res, 50))
    first.close()
    await new Promise((res) => setTimeout(res, 50))

    const second = await connectPeer(port)
    second.send(JSON.stringify({ kind: 'request', id: 'peerA:2', method: 'listAgents', args: [] }))
    await new Promise((res) => setTimeout(res, 50))

    expect(received).toHaveLength(2)
    expect(registry.ownerOf('peerA')).toBeDefined()
    second.close()
  })

  it("removes a peer's claimed connIds when it disconnects", async () => {
    const svc = fakeServiceTransport()
    const registry = createConnRegistry()
    // Mirror host/index.ts: wire detach to the server-side ws 'close' so the
    // peer's claimed connIds are released on disconnect.
    server.on('connection', (ws) => {
      const detach = attachBridge({ peer: ws, service: svc as never, log: console, registry })
      ws.on('close', () => detach())
    })

    const peer = await connectPeer(port)
    peer.send(JSON.stringify({ kind: 'request', id: 'peerA:1', method: 'listAgents', args: [] }))
    await new Promise((res) => setTimeout(res, 50))
    // ownerOf returns the server-side ws this test can't reach; assert it is
    // claimed (defined) here, then released (undefined) after disconnect.
    expect(registry.ownerOf('peerA')).toBeDefined()

    peer.close()
    await new Promise((res) => setTimeout(res, 50))
    expect(registry.ownerOf('peerA')).toBeUndefined()
  })
})
