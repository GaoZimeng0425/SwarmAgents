// Wire protocol for the Main <-> Service utilityProcess channel.
// Main sends ServiceRequest; Service replies with ServiceResponse (matched by
// `id`), pushes ServiceEvent unsolicited, and sends one ServiceReady at boot.

export type ServiceMethod =
  | 'createSession'
  | 'submitGoal'
  | 'listSessions'
  | 'getSessionTasks'
  | 'getRunEvents'
  | 'deleteSession'
  | 'renameSession'
  | 'setSessionPinned'
  | 'updateSessionSettings'
  | 'reorderSessions'
  | 'decidePermission'
  | 'cancelTask'
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

export type ServiceRequest = {
  kind: 'request'
  id: number
  method: ServiceMethod
  args: unknown[]
}

export type ServiceResponse =
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: string }

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
