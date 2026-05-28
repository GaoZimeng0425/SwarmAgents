import { describe, it, expect, vi } from 'vitest'
import { createSseBroadcaster, createSseClient } from './sse'
import type { ServerResponse } from 'node:http'

function mockRes() {
  const chunks: string[] = []
  return {
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => { chunks.push(chunk); return true }),
    end: vi.fn(),
    chunks,
  } as unknown as ServerResponse & { chunks: string[] }
}

describe('SSE', () => {
  it('createSseClient sends well-formed SSE lines', () => {
    const res = mockRes() as ReturnType<typeof mockRes>
    const client = createSseClient(res)
    client.send('task.progress', { taskId: 'abc' })
    expect(res.write).toHaveBeenCalledWith(
      `event: task.progress\ndata: ${JSON.stringify({ taskId: 'abc' })}\n\n`,
    )
  })

  it('broadcaster delivers to all connected clients', () => {
    const broadcaster = createSseBroadcaster()
    const res1 = mockRes() as ReturnType<typeof mockRes>
    const res2 = mockRes() as ReturnType<typeof mockRes>
    const c1 = createSseClient(res1)
    const c2 = createSseClient(res2)
    broadcaster.addClient(c1)
    broadcaster.addClient(c2)
    broadcaster.broadcast('task.complete', { taskId: 'x' })
    expect(res1.write).toHaveBeenCalledTimes(1)
    expect(res2.write).toHaveBeenCalledTimes(1)
  })

  it('broadcaster skips removed clients', () => {
    const broadcaster = createSseBroadcaster()
    const res = mockRes() as ReturnType<typeof mockRes>
    const client = createSseClient(res)
    broadcaster.addClient(client)
    broadcaster.removeClient(client)
    broadcaster.broadcast('task.complete', { taskId: 'x' })
    expect(res.write).not.toHaveBeenCalled()
  })
})
