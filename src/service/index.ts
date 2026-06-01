import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@shared/logger'
import type { ProviderInjection } from '@shared/types/provider'

import { createConversationStore } from './conversation-store'
import { createServer } from './server'
import { createSessionManager } from './session-manager'
import { createSseBroadcaster } from './sse'
import { registerBuiltinTools } from './tools/builtins'
import { createToolRegistry } from './tools/registry'

const log = createLogger({ process: 'service' }).child({ component: 'index' })

const dbPath = process.env.SWARM_SERVICE_DB_PATH ?? join(tmpdir(), 'swarm-agent-service.db')

const store = createConversationStore(dbPath)
const broadcaster = createSseBroadcaster()

const toolRegistry = createToolRegistry()
registerBuiltinTools(toolRegistry)

const providerRegistry = new Map<string, ProviderInjection>()

const manager = createSessionManager({
  store,
  broadcaster,
  maxConcurrent: 4,
  getProvider: (key) => providerRegistry.get(key),
  toolRegistry,
})

const server = createServer({
  manager,
  broadcaster,
  registerProvider: (provider) => {
    providerRegistry.set(provider.id, provider)
  },
})

server.listen(0, '127.0.0.1', () => {
  const addr = server.address() as { port: number }
  const out = JSON.stringify({ type: 'service-started', port: addr.port })
  process.stdout.write(`${out}\n`)
  log.info({ msg: 'service started', port: addr.port, dbPath })
})

process.on('SIGTERM', () => {
  log.info({ msg: 'shutting down' })
  server.close(() => {
    store.close()
    process.exit(0)
  })
})
