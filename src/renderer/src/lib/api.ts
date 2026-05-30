import type { PermissionDecision, SessionSummary, SubmitGoalResult, UIEvent } from '@shared/types/ui'
import type { Task } from '@shared/types/task'

export const swarmApi = {
  submitGoal: (sessionId: string, goal: string): Promise<SubmitGoalResult> =>
    window.swarm.submitGoal(sessionId, goal),
  cancelTask: (sessionId: string, taskId: string): Promise<void> => window.swarm.cancelTask(sessionId, taskId),
  decidePermission: (sessionId: string, actionId: string, decision: PermissionDecision): Promise<void> =>
    window.swarm.decidePermission(sessionId, actionId, decision),
  subscribeEvents: (cb: (e: UIEvent) => void): (() => void) => window.swarm.subscribeEvents(cb),
  listSessions: (): Promise<SessionSummary[]> => window.swarm.sessions.list(),
  createSession: (): Promise<{ sessionId: string }> => window.swarm.sessions.create(),
  getSessionTasks: (sessionId: string): Promise<Task[]> => window.swarm.sessions.getTasks(sessionId),
}
