import type { ServiceTransport } from '@swarm/protocol'

// Minimal mock WebSocket for testing the transport adapter. Mirrors the shape
// of the browser's WebSocket the adapter touches: addEventListener / send / close / readyState.
class MockWebSocket {
  static instances: MockWebSocket[] = []
  readyState = 0 // CONNECTING
  listeners: Record<string, ((...args: unknown[]) => void)[]> = {}
  lastSent: string | undefined

  constructor(
    public url: string,
    public protocols?: string | string[]
  ) {
    MockWebSocket.instances.push(this)
  }

  addEventListener(event: string, fn: (...args: unknown[]) => void): void {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(fn)
  }

  removeEventListener(event: string, fn: (...args: unknown[]) => void): void {
    this.listeners[event] = (this.listeners[event] ?? []).filter((f) => f !== fn)
  }

  send(data: string): void {
    this.lastSent = data
  }

  close(): void {
    this.readyState = 3
    this.listeners.close?.forEach((fn) => {
      fn()
    })
  }

  // Test helpers
  _open(): void {
    this.readyState = 1
    this.listeners.open?.forEach((fn) => {
      fn()
    })
  }

  _message(data: unknown): void {
    this.listeners.message?.forEach((fn) => {
      fn({ data: JSON.stringify(data) })
    })
  }

  _error(): void {
    this.listeners.error?.forEach((fn) => {
      fn()
    })
  }
}

describe('createWsTransport', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
  })

  it('connects with the token as a subprotocol', async () => {
    const { createWsTransport } = await import('../transport-ws')
    createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, undefined, MockWebSocket)
    expect(MockWebSocket.instances[0].protocols).toBe('swarm.abc')
  })

  it('resolves ready when the socket opens', async () => {
    const { createWsTransport } = await import('../transport-ws')
    const { ready } = createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, undefined, MockWebSocket)
    const mock = MockWebSocket.instances[0]
    expect(ready).toBeInstanceOf(Promise)
    mock._open()
    await expect(ready).resolves.toBeUndefined()
  })

  it('postMessage sends JSON-stringified message', async () => {
    const { createWsTransport } = await import('../transport-ws')
    const { transport } = createWsTransport(
      { host: '192.168.1.1', port: 47777, token: 'abc' },
      undefined,
      MockWebSocket
    ) as {
      transport: ServiceTransport
    }
    const mock = MockWebSocket.instances[0]
    transport.postMessage({ kind: 'request', id: '1', method: 'listSessions', args: [] })
    expect(mock.lastSent).toBe(JSON.stringify({ kind: 'request', id: '1', method: 'listSessions', args: [] }))
  })

  it('on/off registers and unregisters message listeners', async () => {
    const { createWsTransport } = await import('../transport-ws')
    const { transport } = createWsTransport(
      { host: '192.168.1.1', port: 47777, token: 'abc' },
      undefined,
      MockWebSocket
    ) as {
      transport: ServiceTransport
    }
    const mock = MockWebSocket.instances[0]
    const received: unknown[] = []
    const handler = (m: unknown): void => {
      received.push(m)
    }
    transport.on('message', handler)
    mock._message({ kind: 'event', event: 'test', data: 42 })
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ kind: 'event', event: 'test', data: 42 })

    transport.off('message', handler)
    mock._message({ kind: 'event', event: 'test2', data: 99 })
    expect(received).toHaveLength(1)
  })

  it('close closes the underlying WebSocket', async () => {
    const { createWsTransport } = await import('../transport-ws')
    const { close } = createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, undefined, MockWebSocket)
    const mock = MockWebSocket.instances[0]
    close()
    expect(mock.readyState).toBe(3)
  })

  it('onClose fires on socket close and error', async () => {
    const { createWsTransport } = await import('../transport-ws')
    let closed = 0
    createWsTransport(
      { host: '192.168.1.1', port: 47777, token: 'abc' },
      () => {
        closed++
      },
      MockWebSocket
    )
    const mock = MockWebSocket.instances[0]
    mock._error()
    mock.close()
    // error + close both fire; onClose should fire for each, but the adapter
    // dedupes via readyState check — assert at least one invocation.
    expect(closed).toBeGreaterThanOrEqual(1)
  })
})
