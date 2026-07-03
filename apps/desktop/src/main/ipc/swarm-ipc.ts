import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname } from 'node:path'
import { createLogger } from '@shared/logger'
import type { ServiceClient } from '@swarm/protocol'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'

import type { Service as BudgetsService } from '../budgets'
import { swarmHome } from '../constants'
import type { Service as McpService } from '../mcp-servers'
import type { Service as ProvidersService } from '../providers'
import { getAccent, subscribeAccent } from '../system/accent'
import { getMacPermissions, openPrivacySettings } from '../system/permissions'
import type { Service as WebSearchService } from '../web-search'

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

// The document extensions render_ui can inline-preview (mirrors renderer fileKind).
const DOCUMENT_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
}
// Documents can be larger than images; cap so a huge PDF doesn't become a giant
// base64 string crossing the IPC bridge.
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024

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
  ipcMain.handle('agents:list', () => serviceClient.listAgents())
  ipcMain.handle('skills:save', (_e: Electron.IpcMainInvokeEvent, skill: import('@swarm/protocol').Skill) =>
    serviceClient.saveSkill(skill)
  )
  ipcMain.handle('skills:delete', (_e: Electron.IpcMainInvokeEvent, name: string) => serviceClient.deleteSkill(name))
  ipcMain.handle('agents:save', (_e: Electron.IpcMainInvokeEvent, def: import('@swarm/protocol').AgentDefinition) =>
    serviceClient.saveAgent(def)
  )
  ipcMain.handle('agents:delete', (_e: Electron.IpcMainInvokeEvent, id: string) => serviceClient.deleteAgent(id))
  ipcMain.handle('agents:restore-defaults', () => serviceClient.restoreDefaultAgents())
  ipcMain.handle(
    'skills:import',
    async (e: Electron.IpcMainInvokeEvent, arg?: { sourceDir?: string; overwrite?: boolean }) => {
      let sourceDir = arg?.sourceDir
      if (!sourceDir) {
        const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined
        const res = parent
          ? await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
          : await dialog.showOpenDialog({ properties: ['openDirectory'] })
        if (res.canceled || res.filePaths.length === 0) {
          log.info({ msg: 'skills:import cancelled' })
          return { ok: false, code: 'cancelled', message: 'Import cancelled.' }
        }
        sourceDir = res.filePaths[0]
      }
      log.info({ msg: 'skills:import', sourceDir, overwrite: arg?.overwrite ?? false })
      const r = await serviceClient.importSkill(sourceDir, arg?.overwrite)
      // Echo the chosen dir back on a name clash so the renderer can retry with overwrite.
      if (!r.ok && r.code === 'exists') return { ...r, sourceDir }
      return r
    }
  )
  ipcMain.handle('memory:list', (_e: Electron.IpcMainInvokeEvent, namespace?: string) =>
    serviceClient.listMemory(namespace)
  )

  // ---- Tool toggles (service owns the state; main is a thin passthrough) ----
  ipcMain.handle('toolToggles:get', () => serviceClient.getToolToggles())
  ipcMain.handle('toolToggles:setSkill', (_e: Electron.IpcMainInvokeEvent, name: string, enabled: boolean) =>
    serviceClient.setSkillEnabled(name, enabled)
  )
  ipcMain.handle('toolToggles:setToolGroup', (_e: Electron.IpcMainInvokeEvent, group: string, enabled: boolean) =>
    serviceClient.setToolGroupEnabled(group, enabled)
  )
  ipcMain.handle('tools:listGroups', () => serviceClient.listToolGroups())

  // ---- Renderer → Main RPC handlers ----

  const createSession = async (): Promise<{ sessionId: string }> => {
    const injection = providers.getInjection()
    if (!injection) throw new Error('Configure an API key in Settings before starting a chat.')
    const { sessionId } = await serviceClient.createSession(injection)
    log.info({ msg: 'session created', sessionId, provider: injection.id })
    return { sessionId }
  }

  const listSessions = (): Promise<import('@swarm/protocol').SessionSummary[]> => serviceClient.listSessions()

  const getSessionTasks = (_e: Electron.IpcMainInvokeEvent, sessionId: string) =>
    serviceClient.getSessionTasks(sessionId)

  const getConversationEvents = (_e: Electron.IpcMainInvokeEvent, sessionId: string) =>
    serviceClient.getConversationEvents(sessionId)

  const getUsageStats = (_e: Electron.IpcMainInvokeEvent, rangeDays: number) => serviceClient.getUsageStats(rangeDays)

  const deleteSession = (_e: Electron.IpcMainInvokeEvent, sessionId: string) => serviceClient.deleteSession(sessionId)

  const renameSession = (_e: Electron.IpcMainInvokeEvent, sessionId: string, title: string) =>
    serviceClient.renameSession(sessionId, title)

  const setSessionPinned = (_e: Electron.IpcMainInvokeEvent, sessionId: string, pinned: boolean) =>
    serviceClient.setSessionPinned(sessionId, pinned)

  const updateSessionSettings = (
    _e: Electron.IpcMainInvokeEvent,
    sessionId: string,
    settings: import('@swarm/protocol').SessionSettings
  ) => serviceClient.updateSessionSettings(sessionId, settings)

  const reorderSessions = (_e: Electron.IpcMainInvokeEvent, orderedIds: string[]) =>
    serviceClient.reorderSessions(orderedIds)

  const submitGoal = async (
    _e: Electron.IpcMainInvokeEvent,
    sessionId: string,
    goal: string,
    attachments?: import('@swarm/protocol').Attachment[],
    options?: import('@swarm/protocol').TaskOptions
  ): Promise<{ taskId: string }> => {
    if (typeof goal !== 'string' || goal.trim().length === 0) {
      throw new Error('goal must be a non-empty string')
    }
    const trimmedGoal = goal.trim()
    const { taskId } = await serviceClient.submitGoal(sessionId, trimmedGoal, attachments, options)
    log.info({
      msg: 'task submitted',
      sessionId,
      taskId,
      attachments: attachments?.length ?? 0,
      cwd: options?.cwd ?? null,
      permissionMode: options?.permissionMode ?? 'ask',
      executionMode: options?.executionMode ?? 'goal',
    })
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

  const interruptWith = async (_e: Electron.IpcMainInvokeEvent, sessionId: string, taskId: string): Promise<void> => {
    try {
      await serviceClient.interruptWith(sessionId, taskId)
      log.info({ msg: 'interruptWith requested', sessionId, taskId })
    } catch (err) {
      log.warn({ msg: 'interruptWith failed', sessionId, taskId, err: String(err) })
    }
  }

  const decidePermission = (
    _e: Electron.IpcMainInvokeEvent,
    sessionId: string,
    actionId: string,
    decision: string
  ): void => {
    void serviceClient
      .decidePermission(sessionId, actionId, decision as import('@swarm/protocol').PermissionDecision)
      .catch((err: unknown) => log.warn({ msg: 'decidePermission failed', err: String(err) }))
    log.info({ msg: 'permission decided', sessionId, actionId, decision })
  }

  const listCronJobsForSession = (_e: Electron.IpcMainInvokeEvent, sessionId: string) =>
    serviceClient.listCronJobsForSession(sessionId)
  const listAllCronJobs = () => serviceClient.listAllCronJobs()
  const listAllCronRuns = () => serviceClient.listAllCronRuns()
  const cancelCronJob = (_e: Electron.IpcMainInvokeEvent, id: string) => serviceClient.cancelCronJob(id)

  ipcMain.handle('swarm:createSession', () => createSession())
  ipcMain.handle('swarm:listSessions', () => listSessions())
  ipcMain.handle('swarm:getSessionTasks', getSessionTasks)
  ipcMain.handle('swarm:getConversationEvents', getConversationEvents)
  ipcMain.handle('swarm:getUsageStats', getUsageStats)
  ipcMain.handle('swarm:deleteSession', deleteSession)
  ipcMain.handle('swarm:renameSession', renameSession)
  ipcMain.handle('swarm:setSessionPinned', setSessionPinned)
  ipcMain.handle('swarm:updateSessionSettings', updateSessionSettings)
  ipcMain.handle('swarm:reorderSessions', reorderSessions)
  ipcMain.handle('swarm:submitGoal', submitGoal)
  ipcMain.handle('swarm:cancelTask', cancelTask)
  ipcMain.handle('swarm:interruptWith', interruptWith)
  ipcMain.handle('swarm:decidePermission', decidePermission)
  ipcMain.handle('swarm:listCronJobsForSession', listCronJobsForSession)
  ipcMain.handle('swarm:listAllCronJobs', () => listAllCronJobs())
  ipcMain.handle('swarm:listAllCronRuns', () => listAllCronRuns())
  ipcMain.handle('swarm:cancelCronJob', cancelCronJob)

  const handleGetAccent = (): string | null => getAccent()
  ipcMain.handle('system:getAccent', handleGetAccent)

  const ACCENT_CHANGE_CHANNEL = 'system:accentChange'
  const unsubscribeAccent = subscribeAccent((hex) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(ACCENT_CHANGE_CHANNEL, { hex })
    }
  })

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

  const readDocumentFile = async (
    _e: Electron.IpcMainInvokeEvent,
    path: unknown
  ): Promise<{ mediaType: string; data: string } | null> => {
    if (typeof path !== 'string') return null
    const mediaType = DOCUMENT_MIME[extname(path).toLowerCase()]
    if (!mediaType) return null
    try {
      const buf = await readFile(expandHome(path))
      if (buf.byteLength > MAX_DOCUMENT_BYTES) return null
      return { mediaType, data: buf.toString('base64') }
    } catch (err) {
      log.warn({ msg: 'readDocumentFile failed', path, err: String(err) })
      return null
    }
  }
  ipcMain.handle('system:readDocumentFile', readDocumentFile)

  const openPath = async (_e: Electron.IpcMainInvokeEvent, path: unknown): Promise<void> => {
    if (typeof path !== 'string') return
    const err = await shell.openPath(expandHome(path))
    if (err) log.warn({ msg: 'openPath failed', path, err })
  }
  ipcMain.handle('system:openPath', openPath)

  // Reveal the ~/.swarm-agents folder so the user can drop in skill folders
  // (skills/<name>/SKILL.md), agent folders, edit mcp-servers.json, etc.
  const openUserDataDir = async (): Promise<void> => {
    const dir = swarmHome()
    const err = await shell.openPath(dir)
    if (err) log.warn({ msg: 'openUserDataDir failed', dir, err })
  }
  ipcMain.handle('system:openUserDataDir', openUserDataDir)

  // Native folder/file picker for the composer's working-directory and
  // file-reference controls. Returns the chosen absolute path, or null when the
  // user cancels (or picks nothing).
  const pickPath = async (e: Electron.IpcMainInvokeEvent, kind: unknown): Promise<string | null> => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const properties: Array<'openDirectory' | 'openFile'> = kind === 'directory' ? ['openDirectory'] : ['openFile']
    const result = parent
      ? await dialog.showOpenDialog(parent, { properties })
      : await dialog.showOpenDialog({ properties })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  }
  ipcMain.handle('system:pickPath', pickPath)

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
      ipcMain.removeHandler('agents:list')
      ipcMain.removeHandler('skills:save')
      ipcMain.removeHandler('skills:delete')
      ipcMain.removeHandler('agents:save')
      ipcMain.removeHandler('agents:delete')
      ipcMain.removeHandler('agents:restore-defaults')
      ipcMain.removeHandler('skills:import')
      ipcMain.removeHandler('toolToggles:get')
      ipcMain.removeHandler('toolToggles:setSkill')
      ipcMain.removeHandler('toolToggles:setToolGroup')
      ipcMain.removeHandler('tools:listGroups')
      ipcMain.removeHandler('memory:list')
      ipcMain.removeHandler('system:openPrivacySettings')
      ipcMain.removeHandler('system:getMacPermissions')
      ipcMain.removeHandler('system:readImageFile')
      ipcMain.removeHandler('system:readDocumentFile')
      ipcMain.removeHandler('system:openPath')
      ipcMain.removeHandler('system:openUserDataDir')
      ipcMain.removeHandler('system:pickPath')
      ipcMain.removeHandler('system:getAccent')
      unsubscribeAccent()
      ipcMain.removeHandler('swarm:createSession')
      ipcMain.removeHandler('swarm:listSessions')
      ipcMain.removeHandler('swarm:getSessionTasks')
      ipcMain.removeHandler('swarm:getConversationEvents')
      ipcMain.removeHandler('swarm:getUsageStats')
      ipcMain.removeHandler('swarm:deleteSession')
      ipcMain.removeHandler('swarm:renameSession')
      ipcMain.removeHandler('swarm:setSessionPinned')
      ipcMain.removeHandler('swarm:updateSessionSettings')
      ipcMain.removeHandler('swarm:reorderSessions')
      ipcMain.removeHandler('swarm:submitGoal')
      ipcMain.removeHandler('swarm:cancelTask')
      ipcMain.removeHandler('swarm:interruptWith')
      ipcMain.removeHandler('swarm:decidePermission')
      ipcMain.removeHandler('swarm:listCronJobsForSession')
      ipcMain.removeHandler('swarm:listAllCronJobs')
      ipcMain.removeHandler('swarm:listAllCronRuns')
      ipcMain.removeHandler('swarm:cancelCronJob')
    },
  }
}
