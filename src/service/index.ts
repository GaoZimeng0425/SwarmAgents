import { createLogger } from '@shared/logger'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationStore } from './conversation-store'
import { createSseBroadcaster } from './sse'
import { createSessionManager } from './session-manager'
import { createServer } from './server'

const log = createLogger({ process: 'service' }).child({ component: 'index' })

const dbPath = process.env.SWARM_SERVICE_DB_PATH ?? join(tmpdir(), 'swarm-agent-service.db')

const store = createConversationStore(dbPath)
const broadcaster = createSseBroadcaster()
const manager = createSessionManager({
  store, broadcaster, maxConcurrent: 4,
  getProvider: () => undefined,
})
const server = createServer({ manager, broadcaster })

server.listen(0, '127.0.0.1', () => {
  const addr = server.address() as { port: number }
  const out = JSON.stringify({ type: 'service-started', port: addr.port })
  process.stdout.write(out + '\n')
  log.info({ msg: 'service started', port: addr.port, dbPath })
})

process.on('SIGTERM', () => {
  log.info({ msg: 'shutting down' })
  server.close(() => {
    store.close()
    process.exit(0)
  })
})
