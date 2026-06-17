// Entry point for the MCP-servers config subsystem. Wires the plaintext store
// (hand-editable mcp-servers.json), the in-memory config service, a file watcher
// for live reload, and the renderer↔main config IPC. Must run after
// app.whenReady() and before any BrowserWindow so the first render sees state.
// (The service-process bridge — pushing configs + relaying live status — is
// wired later in swarm-ipc, once the service client exists.)
import { join } from 'node:path'
import { createLogger } from '@shared/logger'
import { app } from 'electron'

import { wireMcpConfigIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'mcp-servers' })

export type McpServersHandle = {
  service: Service
  dispose(): void
}

export async function initMcpServers(): Promise<McpServersHandle> {
  const filePath = join(app.getPath('userData'), 'mcp-servers.json')
  const store = createStore({ filePath })

  const service = await createService({ store })
  const { dispose: disposeIpc } = wireMcpConfigIpc({ service })
  // Reload live when the file is hand-edited or rewritten by the agent's fs tools.
  const offWatch = store.watch(() => void service.reload())
  log.info({ msg: 'mcp config ready', path: filePath })

  return {
    service,
    dispose() {
      offWatch()
      disposeIpc()
    },
  }
}

export type { Service } from './service'
