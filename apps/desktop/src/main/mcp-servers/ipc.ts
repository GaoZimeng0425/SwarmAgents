// Renderer ↔ Main IPC for MCP *config* CRUD. Status (live connection state)
// comes from the service process and is wired separately in swarm-ipc.
import { type McpServerConfig, McpServerConfigSchema, type McpToolOverride } from '@swarm/protocol'

import { createIpcRegistrar, sendToAllWindows } from '../ipc/wire'
import type { Service } from './service'

export function wireMcpConfigIpc(args: { service: Service }): { dispose: () => void } {
  const { service } = args
  const ipc = createIpcRegistrar()

  const off = service.onChange((configs) => sendToAllWindows('mcp:configChanged', configs))

  ipc.handle('mcp:list', () => service.list())
  ipc.handle('mcp:add', (_e, input: Omit<McpServerConfig, 'id'>) =>
    // Validate the shape minus id (the service assigns it).
    service.add(McpServerConfigSchema.omit({ id: true }).parse(input) as Omit<McpServerConfig, 'id'>)
  )
  ipc.handle('mcp:update', (_e, id: string, patch: Partial<Omit<McpServerConfig, 'id'>>) => service.update(id, patch))
  ipc.handle('mcp:remove', (_e, id: string) => service.remove(id))
  ipc.handle('mcp:setEnabled', (_e, id: string, enabled: boolean) => service.setEnabled(id, enabled))
  ipc.handle('mcp:setToolOverride', (_e, id: string, toolName: string, override: McpToolOverride | null) =>
    service.setToolOverride(id, toolName, override)
  )

  return {
    dispose(): void {
      off()
      ipc.dispose()
    },
  }
}
