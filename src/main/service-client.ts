import { request as httpRequest } from 'node:http'
import { createLogger } from '@shared/logger'
import type { ProviderInjection } from '@shared/types/provider'
import type { PermissionDecision } from '@shared/types/ui'

const log = createLogger({ process: 'main' }).child({ component: 'service-client' })

type ServiceClientConfig = {
  port: number
  onEvent?: (event: string, data: unknown) => void
}

export type ServiceClient = {
  connect(): Promise<void>
  disconnect(): void
  createSession(provider: ProviderInjection): Promise<{ sessionId: string }>
  submitGoal(sessionId: string, goal: string): Promise<{ taskId: string }>
  listSessions(): Promise<import('@shared/types/ui').SessionSummary[]>
  getSessionTasks(sessionId: string): Promise<import('@shared/types/task').Task[]>
  decidePermission(sessionId: string, actionId: string, decision: PermissionDecision): Promise<void>
  cancelTask(sessionId: string, taskId: string): Promise<void>
}

function get<T>(port: number, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString()) as T) }
        catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function post<T>(port: number, path: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest(
      {
        hostname: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString()) as T) }
          catch (e) { reject(e) }
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

export function createServiceClient(cfg: ServiceClientConfig): ServiceClient {
  const { port, onEvent } = cfg
  let sseReq: import('node:http').ClientRequest | null = null

  return {
    connect() {
      return new Promise((resolve) => {
        sseReq = httpRequest(
          {
            hostname: '127.0.0.1', port, path: '/events', method: 'GET',
            headers: { Accept: 'text/event-stream' },
          },
          (res) => {
            let eventName = ''
            let buffer = ''
            res.setEncoding('utf8')
            res.on('data', (chunk: string) => {
              buffer += chunk
              const lines = buffer.split('\n')
              buffer = lines.pop() ?? ''
              for (const line of lines) {
                if (line.startsWith('event: ')) {
                  eventName = line.slice(7).trim()
                } else if (line.startsWith('data: ')) {
                  const raw = line.slice(6)
                  try {
                    const data = JSON.parse(raw) as unknown
                    if (onEvent && eventName) onEvent(eventName, data)
                  } catch {
                    log.warn({ msg: 'SSE parse error', raw })
                  }
                  eventName = ''
                }
              }
            })
            resolve()
          },
        )
        sseReq.on('error', (err) => log.warn({ msg: 'SSE connection error', err: String(err) }))
        sseReq.end()
      })
    },

    disconnect() {
      sseReq?.destroy()
      sseReq = null
    },

    createSession(provider) {
      return post(port, '/sessions', { provider })
    },

    submitGoal(sessionId, goal) {
      return post(port, `/sessions/${sessionId}/goal`, { goal })
    },

    listSessions() {
      return get(port, '/sessions')
    },

    getSessionTasks(sessionId) {
      return get(port, `/sessions/${sessionId}/tasks`)
    },

    async decidePermission(sessionId, actionId, decision) {
      await post(port, `/sessions/${sessionId}/permission`, { actionId, decision })
    },

    async cancelTask(sessionId, taskId) {
      await post(port, `/sessions/${sessionId}/cancel`, { taskId })
    },
  }
}
