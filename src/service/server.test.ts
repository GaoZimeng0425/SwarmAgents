import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer } from './server'
import type { SessionManager } from './session-manager'
import type { SseBroadcaster } from './sse'
import { createSseBroadcaster } from './sse'

function mockManager(): SessionManager {
  return {
    createSession: vi.fn().mockReturnValue({ sessionId: 'ses-1' }),
    submitGoal: vi.fn().mockReturnValue({ taskId: 'task-1' }),
    resolvePermission: vi.fn(),
    endSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([{ id: 'ses-1' }]),
    getSessionTasks: vi.fn().mockReturnValue([]),
  }
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

describe('Service HTTP server', () => {
  let port: number
  let close: () => Promise<void>
  let manager: SessionManager
  let broadcaster: SseBroadcaster

  beforeEach(async () => {
    manager = mockManager()
    broadcaster = createSseBroadcaster()
    const server = createServer({ manager, broadcaster, registerProvider: vi.fn() })
    port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as { port: number }).port)
      })
    })
    close = () => new Promise((res) => server.close(() => res()))
  })

  afterEach(() => close())

  it('POST /sessions creates a session', async () => {
    const res = await request(port, 'POST', '/sessions', {
      provider: { id: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' },
    })
    expect(res.status).toBe(200)
    expect((res.body as { sessionId: string }).sessionId).toBe('ses-1')
    expect(manager.createSession).toHaveBeenCalledOnce()
  })

  it('POST /sessions/:id/goal submits a goal', async () => {
    const res = await request(port, 'POST', '/sessions/ses-1/goal', {
      goal: 'do something',
      provider: { id: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' },
    })
    expect(res.status).toBe(200)
    expect((res.body as { taskId: string }).taskId).toBe('task-1')
  })

  it('POST /sessions/:id/permission routes decision', async () => {
    const res = await request(port, 'POST', '/sessions/ses-1/permission', {
      actionId: 'act-1', decision: 'grant',
    })
    expect(res.status).toBe(200)
    expect(manager.resolvePermission).toHaveBeenCalledWith('ses-1', 'act-1', 'grant')
  })

  it('GET /health returns 200', async () => {
    const res = await request(port, 'GET', '/health')
    expect(res.status).toBe(200)
  })

  it('GET /sessions returns the session list', async () => {
    await request(port, 'POST', '/sessions', { provider: { id: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'k' } })
    const res = await request(port, 'GET', '/sessions')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect((res.body as unknown[]).length).toBeGreaterThanOrEqual(1)
    expect(typeof (res.body as { id: string }[])[0].id).toBe('string')
  })

  it('GET /sessions/:id/tasks returns tasks for the session', async () => {
    const created = await request(port, 'POST', '/sessions', { provider: { id: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'k' } })
    const sessionId = (created.body as { sessionId: string }).sessionId
    const res = await request(port, 'GET', `/sessions/${sessionId}/tasks`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })
})
