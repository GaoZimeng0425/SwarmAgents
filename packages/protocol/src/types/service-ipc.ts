// Wire protocol for the Main <-> Service utilityProcess channel.
// Main sends ServiceRequest; Service replies with ServiceResponse (matched by
// `id`), pushes ServiceEvent unsolicited, and sends one ServiceReady at boot.

export type ServiceMethod =
  | 'createSession'
  | 'submitGoal'
  | 'listSessions'
  | 'getRunEvents'
  | 'deleteSession'
  | 'renameSession'
  | 'setSessionPinned'
  | 'updateSessionSettings'
  | 'reorderSessions'
  | 'decidePermission'
  | 'cancelRun'
  | 'interruptWith'
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
  | 'analyzeEmail'
  | 'analyzeThread'
  | 'collectArticle'
  | 'analyzeArticle'
  | 'listArticles'
  | 'getArticleAnalysis'
  | 'deleteArticle'
  | 'researchRepo'
  | 'getRepoResearch'
  | 'researchedRepoNames'
  | 'exportSessionMarkdown'

// `id` is a string, not a number: it's prefixed per ServiceClient instance
// (see service-client.ts) so ids never collide across the main process's own
// client and any number of WS-bridged peer clients sharing the same
// service transport — each numbers its own requests from 1 independently.
export type ServiceRequest = {
  kind: 'request'
  id: string
  method: ServiceMethod
  args: unknown[]
}

export type ServiceResponse =
  | { kind: 'response'; id: string; ok: true; result: unknown }
  | { kind: 'response'; id: string; ok: false; error: string }

export type ServiceEvent = {
  kind: 'event'
  event: string
  data: unknown
}

export type ServiceReady = { kind: 'ready' }

// Service→Main request/reply: symmetric reverse direction. Main answers a
// MainRequest with a MainResponse matched by `id`. Used by service-side tools
// that need data only Main holds (e.g. the gmail cache).
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

export type MainRequest = {
  kind: 'mainRequest'
  id: number
  method: MainMethod
  args: unknown[]
}

export type MainResponse =
  | { kind: 'mainResponse'; id: number; ok: true; result: unknown }
  | { kind: 'mainResponse'; id: number; ok: false; error: string }

export type MainToService = ServiceRequest | MainResponse
export type ServiceToMain = ServiceResponse | ServiceEvent | ServiceReady | MainRequest
