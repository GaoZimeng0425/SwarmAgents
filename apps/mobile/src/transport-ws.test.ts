import { describe, expect, it } from 'vitest'
import { createWsTransport } from './transport-ws'

// RN's global WebSocket is DOM-event-shaped (addEventListener/message).
class FakeWebSocket {
  static OPEN = 1
  readyState = 0
  private listeners: Record<string, Set<(ev: unknown) => void>> = {}
  sent: string[] = []
  constructor(public url: string, public subprotocol: string) {
    queueMicrotask(() => { this.readyState = 1; this.dispatch('open', {}) })
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.listeners[type] ??= new Set()).add(fn)
  }
  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners[type]?.delete(fn)
  }
  send(data: string): void { this.sent.push(data) }
  close(): void { this.readyState = 3 }
  dispatch(type: string, ev: unknown): void { this.listeners[type]?.forEach((fn) => fn(ev)) }
}

describe('createWsTransport', () => {
  it('resolves ready on open, then relays parsed messages to listeners', async () => {
    const ws = new FakeWebSocket('ws://x', 'swarm.tok')
    const { transport, ready } = createWsTransport(ws as unknown as WebSocket)
    await ready
    const received: unknown[] = []
    transport.on('message', (m) => received.push(m))
    ws.dispatch('message', { data: JSON.stringify({ kind: 'response', id: 1, ok: true, result: { ok: 1 } }) })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ kind: 'response', id: 1 })
  })

  it('postMessage stringifies and sends over the socket', async () => {
    const ws = new FakeWebSocket('ws://x', 'swarm.tok')
    const { transport, ready } = createWsTransport(ws as unknown as WebSocket)
    await ready
    transport.postMessage({ kind: 'request', id: 9, method: 'listAgents', args: [] })
    expect(ws.sent).toEqual([JSON.stringify({ kind: 'request', id: 9, method: 'listAgents', args: [] })])
  })
})
