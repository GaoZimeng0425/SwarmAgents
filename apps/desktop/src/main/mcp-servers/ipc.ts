// Renderer ↔ Main IPC for MCP *config* CRUD. Status (live connection state)
// comes from the service process and is wired separately in swarm-ipc.
import { type McpServerConfig, McpServerConfigSchema, type McpToolOverride } from '@swarm/protocol'
import { BrowserWindow, ipcMain } from 'electron'

import type { Service } from './service'

export const MCP_CONFIG_CHANGED_CHANNEL = 'mcp:configChanged'

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

export function wireMcpConfigIpc(args: { service: Service }): { dispose: () => void } {
  const { service } = args

  const off = service.onChange((configs) => broadcast(MCP_CONFIG_CHANGED_CHANNEL, configs))

  ipcMain.handle('mcp:list', () => service.list())
  ipcMain.handle('mcp:add', (_e, input: Omit<McpServerConfig, 'id'>) =>
    // Validate the shape minus id (the service assigns it).
    service.add(McpServerConfigSchema.omit({ id: true }).parse(input) as Omit<McpServerConfig, 'id'>)
  )
  ipcMain.handle('mcp:update', (_e, id: string, patch: Partial<Omit<McpServerConfig, 'id'>>) =>
    service.update(id, patch)
  )
  ipcMain.handle('mcp:remove', (_e, id: string) => service.remove(id))
  ipcMain.handle('mcp:setEnabled', (_e, id: string, enabled: boolean) => service.setEnabled(id, enabled))
  ipcMain.handle('mcp:setToolOverride', (_e, id: string, toolName: string, override: McpToolOverride | null) =>
    service.setToolOverride(id, toolName, override)
  )

  return {
    dispose(): void {
      off()
      ipcMain.removeHandler('mcp:list')
      ipcMain.removeHandler('mcp:add')
      ipcMain.removeHandler('mcp:update')
      ipcMain.removeHandler('mcp:remove')
      ipcMain.removeHandler('mcp:setEnabled')
      ipcMain.removeHandler('mcp:setToolOverride')
    },
  }
}
