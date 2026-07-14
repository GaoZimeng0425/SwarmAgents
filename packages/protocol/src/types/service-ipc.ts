// Wire protocol for the Main <-> Service utilityProcess channel, and (via the
// WS bridge) for external peers <-> Service. One symmetric request/response
// pair: whoever registers a handler for a method answers it, regardless of
// which side initiated the connection or which side is calling. `id` is a
// string, not a number: it's prefixed per RpcPeer instance (see rpc-peer.ts)
// so ids never collide across main's own peer and any number of WS-bridged
// external peers sharing the same service transport — each numbers its own
// requests from 1 independently.

// Methods the service process can serve — main calls these on behalf of the
// renderer (createSession, submitPrompt, listAgents, ...).
export type ServiceMethod =
  | 'createSession'
  | 'submitPrompt'
  | 'listSessions'
  | 'getMessageEvents'
  | 'deleteSession'
  | 'renameSession'
  | 'setSessionPinned'
  | 'updateSessionSettings'
  | 'reorderSessions'
  | 'decidePermission'
  | 'cancelMessage'
  | 'promoteQueuedMessage'
  | 'setMcpServers'
  | 'getMcpStatus'
  | 'setWebSearchConfig'
  | 'setBudgetConfig'
  | 'listSkills'
  | 'listAgents'
  | 'saveSkill'
  | 'deleteSkill'
  | 'saveAgent'
  | 'deleteAgent'
  | 'restoreDefaultAgents'
  | 'importSkill'
  | 'getToolToggles'
  | 'setSkillEnabled'
  | 'setToolGroupEnabled'
  | 'listToolGroups'
  | 'listMemory'
  | 'getUsageStats'
  | 'listCronJobsForSession'
  | 'listAllCronJobs'
  | 'listAllCronRuns'
  | 'cancelCronJob'
  | 'analyzeThread'
  | 'collectArticle'
  | 'analyzeArticle'
  | 'analyzeBilibili'
  | 'listArticles'
  | 'getArticleAnalysis'
  | 'deleteArticle'
  | 'researchRepo'
  | 'getRepoResearch'
  | 'researchedRepoNames'
  | 'exportSessionMarkdown'
  | 'forkToNewSession'

// Methods only Main can serve — the service process calls these when a tool
// needs data only Main holds (the gmail/calendar cache, QWeather config).
export type MainMethod =
  | 'gmail.search'
  | 'gmail.get_thread'
  | 'gmail.list_recent'
  | 'calendar.list_upcoming'
  | 'calendar.get_event'
  | 'calendar.create_local'
  | 'calendar.update_local'
  | 'calendar.delete_local'
  | 'weather.get_forecast'

export type RpcMethod = ServiceMethod | MainMethod

export type RpcRequest = {
  kind: 'request'
  id: string
  method: RpcMethod
  args: unknown[]
}

export type RpcResponse =
  | { kind: 'response'; id: string; ok: true; result: unknown }
  | { kind: 'response'; id: string; ok: false; error: string }

export type RpcEvent = {
  kind: 'event'
  event: string
  data: unknown
}

export type RpcReady = { kind: 'ready' }

export type RpcMessage = RpcRequest | RpcResponse | RpcEvent | RpcReady
