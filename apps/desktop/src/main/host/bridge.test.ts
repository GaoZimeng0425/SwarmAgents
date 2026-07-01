import { EventEmitter } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachBridge } from './bridge'

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

describe('ws bridge', () => {
  let server: WebSocketServer
  let port: number
  beforeEach(async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((res) => server.once('listening', res))
    port = (server.address() as { port: number }).port
  })
  afterEach(() => server.close())

  it('relays peer→service (peer sends request JSON, service transport gets it)', async () => {
    const svc = fakeServiceTransport()
    const received: unknown[] = []
    svc.on('message', (m) => received.push(m))
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc as never, log: console }))

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
    ws.send(JSON.stringify({ kind: 'request', id: 1, method: 'listAgents', args: [] }))
    await new Promise((res) => setTimeout(res, 50))
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ kind: 'request', id: 1, method: 'listAgents' })
    ws.close()
  })

  it('relays service→peer (service posts response, peer receives JSON)', async () => {
    const svc = fakeServiceTransport()
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc as never, log: console }))
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
    const seen: unknown[] = []
    ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())))

    svc.emit({ kind: 'response', id: 1, ok: true, result: { agents: [] } })
    await new Promise((res) => setTimeout(res, 50))
    expect(seen[0]).toMatchObject({ kind: 'response', id: 1, ok: true })
    ws.close()
  })
})
