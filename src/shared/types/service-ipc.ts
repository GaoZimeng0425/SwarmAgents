// Wire protocol for the Main <-> Service utilityProcess channel.
// Main sends ServiceRequest; Service replies with ServiceResponse (matched by
// `id`), pushes ServiceEvent unsolicited, and sends one ServiceReady at boot.

export type ServiceMethod =
  | 'createSession'
  | 'submitGoal'
  | 'listSessions'
  | 'getSessionTasks'
  | 'deleteSession'
  | 'renameSession'
  | 'setSessionPinned'
  | 'decidePermission'
  | 'respondAsk'
  | 'cancelTask'
  | 'setMcpServers'
  | 'getMcpStatus'
  | 'listSkills'
  | 'saveSkill'
  | 'deleteSkill'

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

export type MainToService = ServiceRequest
export type ServiceToMain = ServiceResponse | ServiceEvent | ServiceReady
