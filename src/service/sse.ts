import type { ServerResponse } from 'node:http'

export type SseClient = {
  send(event: string, data: unknown): void
  close(): void
}

export function createSseClient(res: ServerResponse): SseClient {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.flushHeaders()

  return {
    send(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    close() {
      res.end()
    },
  }
}

export type SseBroadcaster = {
  addClient(client: SseClient): void
  removeClient(client: SseClient): void
  broadcast(event: string, data: unknown): void
}

export function createSseBroadcaster(): SseBroadcaster {
  const clients = new Set<SseClient>()
  return {
    addClient(client) {
      clients.add(client)
    },
    removeClient(client) {
      clients.delete(client)
    },
    broadcast(event, data) {
      for (const client of clients) client.send(event, data)
    },
  }
}
