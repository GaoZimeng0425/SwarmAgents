import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname } from 'node:path'
import { createLogger } from '@shared/logger'
import { BrowserWindow, ipcMain, shell } from 'electron'

import type { Service as BudgetsService } from '../budgets'
import type { Service as McpService } from '../mcp-servers'
import type { Service as ProvidersService } from '../providers'
import type { ServiceClient } from '../service-client'
import { getAccent, subscribeAccent } from '../system/accent'
import { getMacPermissions, openPrivacySettings } from '../system/permissions'
import type { Service as WebSearchService } from '../web-search'
import { openSettings } from '../windows/settings-window'

const log = createLogger({ process: 'main' }).child({ component: 'swarm-ipc' })

// Only these extensions are read back for inline preview — never arbitrary files.
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
// Guard against turning a huge file into an even larger base64 string.
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

// Agents often report paths with a leading ~; Node's fs/shell don't expand it.
function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p
}

export function wireSwarmIpc(args: {
  serviceClient: ServiceClient
  providers: ProvidersService
  mcpServers: McpService
  webSearch: WebSearchService
  budgets: BudgetsService
}): { dispose: () => void } {
  const { serviceClient, providers, mcpServers, webSearch, budgets } = args

  // ---- MCP config ↔ service bridge ----
  // Push the persisted config to the service now, and on every change. The
  // service connects/disconnects servers and registers their tools.
  void serviceClient.setMcpServers(mcpServers.list()).catch((err: unknown) => {
    log.warn({ msg: 'initial setMcpServers failed', err: String(err) })
  })
  const offMcpChange = mcpServers.onChange((configs) => {
    void serviceClient.setMcpServers(configs).catch((err: unknown) => {
      log.warn({ msg: 'setMcpServers failed', err: String(err) })
    })
  })
  ipcMain.handle('mcp:getStatus', () => serviceClient.getMcpStatus())

  // ---- Web-search config ↔ service bridge ----
  // Push the persisted config (incl. keys) to the service now, and on every
  // change. The web_search tool reads it per call.
  void serviceClient.setWebSearchConfig(webSearch.getInjection()).catch((err: unknown) => {
    log.warn({ msg: 'initial setWebSearchConfig failed', err: String(err) })
  })
  const offWebSearchChange = webSearch.onStateChanged(() => {
    void serviceClient.setWebSearchConfig(webSearch.getInjection()).catch((err: unknown) => {
      log.warn({ msg: 'setWebSearchConfig failed', err: String(err) })
    })
  })

  // ---- Budget config ↔ service bridge ----
  // Push the persisted budgets to the service now, and on every change. The
  // session-manager reads them when creating main/sub-agent tasks.
  void serviceClient.setBudgetConfig(budgets.get()).catch((err: unknown) => {
    log.warn({ msg: 'initial setBudgetConfig failed', err: String(err) })
  })
  const offBudgetsChange = budgets.onStateChanged(() => {
    void serviceClient.setBudgetConfig(budgets.get()).catch((err: unknown) => {
      log.warn({ msg: 'setBudgetConfig failed', err: String(err) })
    })
  })

  // ---- Skills (service owns the files; main is a thin passthrough) ----
  ipcMain.handle('skills:list', () => serviceClient.listSkills())
  ipcMain.handle('skills:save', (_e: Electron.IpcMainInvokeEvent, skill: import('@shared/types/skill').Skill) =>
    serviceClient.saveSkill(skill)
  )
  ipcMain.handle('skills:delete', (_e: Electron.IpcMainInvokeEvent, name: string) => serviceClient.deleteSkill(name))
  ipcMain.handle('memory:list', (_e: Electron.IpcMainInvokeEvent, namespace?: string) =>
    serviceClient.listMemory(namespace)
  )

  // ---- Renderer → Main RPC handlers ----

  const createSession = async (): Promise<{ sessionId: string }> => {
    const injection = providers.getInjection()
    if (!injection) throw new Error('Configure an API key in Settings before starting a chat.')
    const { sessionId } = await serviceClient.createSession(injection)
    log.info({ msg: 'session created', sessionId, provider: injection.id })
    return { sessionId }
  }

  const listSessions = (): Promise<import('@shared/types/ui').SessionSummary[]> => serviceClient.listSessions()

  const getSessionTasks = (_e: Electron.IpcMainInvokeEvent, sessionId: string) =>
    serviceClient.getSessionTasks(sessionId)

  const getUsageStats = (_e: Electron.IpcMainInvokeEvent, rangeDays: number) => serviceClient.getUsageStats(rangeDays)

  const deleteSession = (_e: Electron.IpcMainInvokeEvent, sessionId: string) => serviceClient.deleteSession(sessionId)

  const renameSession = (_e: Electron.IpcMainInvokeEvent, sessionId: string, title: string) =>
    serviceClient.renameSession(sessionId, title)

  const setSessionPinned = (_e: Electron.IpcMainInvokeEvent, sessionId: string, pinned: boolean) =>
    serviceClient.setSessionPinned(sessionId, pinned)

  const reorderSessions = (_e: Electron.IpcMainInvokeEvent, orderedIds: string[]) =>
    serviceClient.reorderSessions(orderedIds)

  const submitGoal = async (
    _e: Electron.IpcMainInvokeEvent,
    sessionId: string,
    goal: string,
    attachments?: import('@shared/types/task').Attachment[]
  ): Promise<{ taskId: string }> => {
    if (typeof goal !== 'string' || goal.trim().length === 0) {
      throw new Error('goal must be a non-empty string')
    }
    const trimmedGoal = goal.trim()
    const { taskId } = await serviceClient.submitGoal(sessionId, trimmedGoal, attachments)
    log.info({ msg: 'task submitted', sessionId, taskId, attachments: attachments?.length ?? 0 })
    return { taskId }
  }

  const cancelTask = async (_e: Electron.IpcMainInvokeEvent, sessionId: string, taskId: string): Promise<void> => {
    try {
      await serviceClient.cancelTask(sessionId, taskId)
      log.info({ msg: 'cancelTask requested', sessionId, taskId })
    } catch (err) {
      log.warn({ msg: 'cancelTask failed', sessionId, taskId, err: String(err) })
    }
  }

  const decidePermission = (
    _e: Electron.IpcMainInvokeEvent,
    sessionId: string,
    actionId: string,
    decision: string
  ): void => {
    void serviceClient
      .decidePermission(sessionId, actionId, decision as import('@shared/types/ui').PermissionDecision)
      .catch((err: unknown) => log.warn({ msg: 'decidePermission failed', err: String(err) }))
    log.info({ msg: 'permission decided', sessionId, actionId, decision })
  }

  const respondAsk = (_e: Electron.IpcMainInvokeEvent, sessionId: string, askId: string, answer: string): void => {
    void serviceClient
      .respondAsk(sessionId, askId, answer)
      .catch((err: unknown) => log.warn({ msg: 'respondAsk failed', err: String(err) }))
    log.info({ msg: 'ask answered', sessionId, askId })
  }

  ipcMain.handle('swarm:createSession', () => createSession())
  ipcMain.handle('swarm:listSessions', () => listSessions())
  ipcMain.handle('swarm:getSessionTasks', getSessionTasks)
  ipcMain.handle('swarm:getUsageStats', getUsageStats)
  ipcMain.handle('swarm:deleteSession', deleteSession)
  ipcMain.handle('swarm:renameSession', renameSession)
  ipcMain.handle('swarm:setSessionPinned', setSessionPinned)
  ipcMain.handle('swarm:reorderSessions', reorderSessions)
  ipcMain.handle('swarm:submitGoal', submitGoal)
  ipcMain.handle('swarm:cancelTask', cancelTask)
  ipcMain.handle('swarm:decidePermission', decidePermission)
  ipcMain.handle('swarm:respondAsk', respondAsk)

  const handleGetAccent = (): string | null => getAccent()
  ipcMain.handle('system:getAccent', handleGetAccent)

  const ACCENT_CHANGE_CHANNEL = 'system:accentChange'
  const unsubscribeAccent = subscribeAccent((hex) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(ACCENT_CHANGE_CHANNEL, { hex })
    }
  })

  const handleOpenSettings = (_: Electron.IpcMainInvokeEvent, opts?: unknown): void => {
    let initialRoute: string | undefined
    if (
      opts &&
      typeof opts === 'object' &&
      'initialRoute' in opts &&
      typeof (opts as { initialRoute?: unknown }).initialRoute === 'string'
    ) {
      initialRoute = (opts as { initialRoute: string }).initialRoute
    }
    openSettings(initialRoute ? { initialRoute } : {})
  }
  ipcMain.handle('system:openSettings', handleOpenSettings)

  const readImageFile = async (
    _e: Electron.IpcMainInvokeEvent,
    path: unknown
  ): Promise<{ mimeType: string; data: string } | null> => {
    if (typeof path !== 'string') return null
    const mimeType = IMAGE_MIME[extname(path).toLowerCase()]
    if (!mimeType) return null
    try {
      const buf = await readFile(expandHome(path))
      if (buf.byteLength > MAX_IMAGE_BYTES) return null
      return { mimeType, data: buf.toString('base64') }
    } catch (err) {
      log.warn({ msg: 'readImageFile failed', path, err: String(err) })
      return null
    }
  }
  ipcMain.handle('system:readImageFile', readImageFile)

  const openPath = async (_e: Electron.IpcMainInvokeEvent, path: unknown): Promise<void> => {
    if (typeof path !== 'string') return
    const err = await shell.openPath(expandHome(path))
    if (err) log.warn({ msg: 'openPath failed', path, err })
  }
  ipcMain.handle('system:openPath', openPath)

  ipcMain.handle('system:getMacPermissions', () => getMacPermissions())
  const handleOpenPrivacySettings = (_e: Electron.IpcMainInvokeEvent, pane: unknown): Promise<void> =>
    openPrivacySettings(pane === 'accessibility' ? 'accessibility' : 'screen')
  ipcMain.handle('system:openPrivacySettings', handleOpenPrivacySettings)

  return {
    dispose(): void {
      offMcpChange()
      offWebSearchChange()
      offBudgetsChange()
      ipcMain.removeHandler('mcp:getStatus')
      ipcMain.removeHandler('skills:list')
      ipcMain.removeHandler('skills:save')
      ipcMain.removeHandler('skills:delete')
      ipcMain.removeHandler('memory:list')
      ipcMain.removeHandler('system:openPrivacySettings')
      ipcMain.removeHandler('system:getMacPermissions')
      ipcMain.removeHandler('system:readImageFile')
      ipcMain.removeHandler('system:openPath')
      ipcMain.removeHandler('system:openSettings')
      ipcMain.removeHandler('system:getAccent')
      unsubscribeAccent()
      ipcMain.removeHandler('swarm:createSession')
      ipcMain.removeHandler('swarm:listSessions')
      ipcMain.removeHandler('swarm:getSessionTasks')
      ipcMain.removeHandler('swarm:getUsageStats')
      ipcMain.removeHandler('swarm:deleteSession')
      ipcMain.removeHandler('swarm:renameSession')
      ipcMain.removeHandler('swarm:setSessionPinned')
      ipcMain.removeHandler('swarm:reorderSessions')
      ipcMain.removeHandler('swarm:submitGoal')
      ipcMain.removeHandler('swarm:cancelTask')
      ipcMain.removeHandler('swarm:decidePermission')
      ipcMain.removeHandler('swarm:respondAsk')
    },
  }
}
