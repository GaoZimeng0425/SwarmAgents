// Entry point for the MCP-servers config subsystem. Wires the encrypted store,
// the in-memory config service, and the renderer↔main config IPC. Must run after
// app.whenReady() and before any BrowserWindow so the first render sees state.
// (The service-process bridge — pushing configs + relaying live status — is
// wired later in swarm-ipc, once the service client exists.)
import { join } from 'node:path'
import { createLogger } from '@shared/logger'
import { app } from 'electron'

import { safeStorageAvailable, wireMcpConfigIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'mcp-servers' })

export type McpServersHandle = {
  service: Service
  dispose(): void
}

export async function initMcpServers(): Promise<McpServersHandle> {
  if (!safeStorageAvailable()) throw new Error('safeStorage unavailable')

  const filePath = join(app.getPath('userData'), 'mcp-servers.enc')
  const store = createStore({ filePath })
  const loadResult = await store.loadOrRecover()
  if (!loadResult.ok) log.warn({ msg: 'mcp config load failed at boot', reason: loadResult.reason })

  const service = await createService({ store })
  const { dispose } = wireMcpConfigIpc({ service })

  return { service, dispose }
}

export { applyAgentMcpAdd } from './agent-bridge'
export type { Service } from './service'
