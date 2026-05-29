import { createServer as createHttpServer, type Server } from 'node:http'
import type { SessionManager } from './session-manager'
import type { SseBroadcaster } from './sse'
import { createSseClient } from './sse'

type ServerConfig = {
  manager: SessionManager
  broadcaster: SseBroadcaster
  registerProvider(provider: import('@shared/types/provider').ProviderInjection): void
}

function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined)
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

export function createServer(cfg: ServerConfig): Server {
  const { manager, broadcaster } = cfg

  return createHttpServer(async (req, res) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    try {
      if (method === 'GET' && url === '/health') {
        json(res, 200, { ok: true })
        return
      }

      if (method === 'GET' && url === '/events') {
        const client = createSseClient(res)
        broadcaster.addClient(client)
        req.on('close', () => broadcaster.removeClient(client))
        return
      }

      if (method === 'POST' && url === '/sessions') {
        const body = (await readBody(req)) as { provider: import('@shared/types/provider').ProviderInjection }
        cfg.registerProvider(body.provider)
        const result = manager.createSession(body.provider)
        json(res, 200, result)
        return
      }

      const goalMatch = /^\/sessions\/([^/]+)\/goal$/.exec(url)
      if (method === 'POST' && goalMatch) {
        const sessionId = goalMatch[1]
        const body = (await readBody(req)) as { goal: string }
        const result = manager.submitGoal(sessionId, body.goal)
        json(res, 200, result)
        return
      }

      const permMatch = /^\/sessions\/([^/]+)\/permission$/.exec(url)
      if (method === 'POST' && permMatch) {
        const sessionId = permMatch[1]
        const body = (await readBody(req)) as {
          actionId: string
          decision: import('@shared/types/ui').PermissionDecision
        }
        manager.resolvePermission(sessionId, body.actionId, body.decision)
        json(res, 200, { ok: true })
        return
      }

      const cancelMatch = /^\/sessions\/([^/]+)\/cancel$/.exec(url)
      if (method === 'POST' && cancelMatch) {
        json(res, 200, { ok: true })
        return
      }

      const deleteMatch = /^\/sessions\/([^/]+)$/.exec(url)
      if (method === 'DELETE' && deleteMatch) {
        manager.endSession(deleteMatch[1])
        json(res, 200, { ok: true })
        return
      }

      json(res, 404, { error: 'not found' })
    } catch (err) {
      json(res, 500, { error: String(err) })
    }
  })
}
