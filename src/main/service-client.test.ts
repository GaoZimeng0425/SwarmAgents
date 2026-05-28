import { createServer as createHttpServer } from 'node:http'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServiceClient } from './service-client'

function startMockService(handler: (url: string, method: string, body: unknown) => unknown) {
  const emitCallbacks: Array<(event: string, data: unknown) => void> = []
  const sockets = new Set<import('node:net').Socket>()
  const server = createHttpServer(async (req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.flushHeaders()
      emitCallbacks.push((event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      })
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    await new Promise((r) => req.on('end', r))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    const result = handler(req.url ?? '/', req.method ?? 'GET', body)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise<{ port: number; emit: (event: string, data: unknown) => void; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port
        resolve({
          port,
          emit: (event, data) => { for (const cb of emitCallbacks) cb(event, data) },
          close: () => {
            for (const s of sockets) s.destroy()
            return new Promise((r) => server.close(() => r()))
          },
        })
      })
    },
  )
}

describe('ServiceClient', () => {
  let mock: Awaited<ReturnType<typeof startMockService>>
  let handler: import('vitest').Mock<(url: string, method: string, body: unknown) => unknown>

  beforeEach(async () => {
    handler = vi.fn().mockReturnValue({ sessionId: 'ses-1' })
    mock = await startMockService((url, method, body) => handler(url, method, body))
  })
  afterEach(() => mock.close())

  it('createSession POSTs to /sessions', async () => {
    const client = createServiceClient({ port: mock.port })
    await client.connect()
    handler.mockReturnValue({ sessionId: 'ses-42' })
    const result = await client.createSession({ id: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' })
    expect(result.sessionId).toBe('ses-42')
    expect(handler).toHaveBeenCalledWith('/sessions', 'POST', expect.objectContaining({ provider: expect.any(Object) }))
    await client.disconnect()
  })

  it('submitGoal POSTs to /sessions/:id/goal', async () => {
    const client = createServiceClient({ port: mock.port })
    await client.connect()
    handler.mockReturnValue({ taskId: 'task-99' })
    const result = await client.submitGoal('ses-1', 'hello world')
    expect(result.taskId).toBe('task-99')
    await client.disconnect()
  })

  it('forwards SSE events via onEvent callback', async () => {
    const received: unknown[] = []
    const client = createServiceClient({ port: mock.port, onEvent: (e, d) => received.push({ e, d }) })
    await client.connect()
    await new Promise((r) => setTimeout(r, 50)) // let SSE handshake settle
    mock.emit('task.complete', { taskId: 'x', summary: 'done', ts: 1 })
    await new Promise((r) => setTimeout(r, 50))
    expect(received.length).toBeGreaterThan(0)
    await client.disconnect()
  })
})
