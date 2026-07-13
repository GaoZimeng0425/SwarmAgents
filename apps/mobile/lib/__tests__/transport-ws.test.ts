import { createWsTransport } from '../transport-ws'

// Minimal mock WebSocket for testing the transport adapter.
class MockWebSocket {
  static instances: MockWebSocket[] = []
  readyState = 0 // CONNECTING
  listeners: Record<string, ((...args: unknown[]) => void)[]> = {}

  constructor(
    public url: string,
    public protocols?: string | string[]
  ) {
    MockWebSocket.instances.push(this)
  }

  addEventListener(event: string, fn: (...args: unknown[]) => void): void {
    const list = this.listeners[event] ?? []
    list.push(fn)
    this.listeners[event] = list
  }

  removeEventListener(event: string, fn: (...args: unknown[]) => void): void {
    this.listeners[event] = (this.listeners[event] ?? []).filter((f) => f !== fn)
  }

  send(data: string): void {
    this.lastSent = data
  }
  lastSent: string | undefined

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

  it('passes the token as a subprotocol', () => {
    createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, MockWebSocket)
    expect(MockWebSocket.instances[0].protocols).toBe('swarm.abc')
  })

  it('resolves ready when the socket opens', async () => {
    const { ready } = createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, MockWebSocket)
    const mock = MockWebSocket.instances[0]
    expect(ready).toBeInstanceOf(Promise)
    mock._open()
    await expect(ready).resolves.toBeUndefined()
  })

  it('rejects ready when the socket errors before opening', async () => {
    // Regression: if the desktop host is down, ready must reject so the caller's
    // await unblocks instead of hanging forever (which leaves the app on the
    // loading screen after a saved pairing auto-connect attempt).
    const { ready } = createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, MockWebSocket)
    const mock = MockWebSocket.instances[0]
    mock._error()
    await expect(ready).rejects.toThrow(/WebSocket connection failed/)
  })

  it('rejects ready when the socket closes before opening', async () => {
    const { ready } = createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, MockWebSocket)
    const mock = MockWebSocket.instances[0]
    mock.close()
    await expect(ready).rejects.toThrow(/WebSocket closed before open/)
  })

  it('postMessage sends JSON-stringified message', () => {
    const { transport } = createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, MockWebSocket)
    const mock = MockWebSocket.instances[0]
    transport.postMessage({ kind: 'request', id: '1', method: 'listSessions', args: [] })
    expect(mock.lastSent).toBe(JSON.stringify({ kind: 'request', id: '1', method: 'listSessions', args: [] }))
  })

  it('on/off registers and unregisters message listeners', () => {
    const { transport } = createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, MockWebSocket)
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
    expect(received).toHaveLength(1) // still 1, handler was removed
  })

  it('close closes the underlying WebSocket', () => {
    const { close } = createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, MockWebSocket)
    const mock = MockWebSocket.instances[0]
    close()
    expect(mock.readyState).toBe(3)
  })

  it('invokes onClose when the socket closes', () => {
    const onClose = jest.fn()
    createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, MockWebSocket, onClose)
    const mock = MockWebSocket.instances[0]
    expect(onClose).not.toHaveBeenCalled()
    mock.close()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('invokes onClose when the socket errors', () => {
    const onClose = jest.fn()
    createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, MockWebSocket, onClose)
    const mock = MockWebSocket.instances[0]
    mock._error()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not invoke onClose when no callback is provided', () => {
    createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, MockWebSocket)
    const mock = MockWebSocket.instances[0]
    // Should not throw even though no onClose was passed.
    expect(() => mock.close()).not.toThrow()
  })
})
