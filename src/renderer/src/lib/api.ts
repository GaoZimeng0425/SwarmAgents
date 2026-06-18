import type { MemoryView } from '@shared/types/memory'
import type { Attachment, Task } from '@shared/types/task'
import type { PermissionDecision, SessionSummary, SubmitGoalResult, UIEvent } from '@shared/types/ui'
import type { UsageStats } from '@shared/types/usage'

export const swarmApi = {
  submitGoal: (sessionId: string, goal: string, attachments?: Attachment[]): Promise<SubmitGoalResult> =>
    window.swarm.submitGoal(sessionId, goal, attachments),
  cancelTask: (sessionId: string, taskId: string): Promise<void> => window.swarm.cancelTask(sessionId, taskId),
  decidePermission: (sessionId: string, actionId: string, decision: PermissionDecision): Promise<void> =>
    window.swarm.decidePermission(sessionId, actionId, decision),
  respondAsk: (sessionId: string, askId: string, answer: string): Promise<void> =>
    window.swarm.respondAsk(sessionId, askId, answer),
  subscribeEvents: (cb: (e: UIEvent) => void): (() => void) => window.swarm.subscribeEvents(cb),
  listSessions: (): Promise<SessionSummary[]> => window.swarm.sessions.list(),
  createSession: (): Promise<{ sessionId: string }> => window.swarm.sessions.create(),
  getSessionTasks: (sessionId: string): Promise<Task[]> => window.swarm.sessions.getTasks(sessionId),
  deleteSession: (sessionId: string): Promise<void> => window.swarm.sessions.delete(sessionId),
  renameSession: (sessionId: string, title: string): Promise<void> => window.swarm.sessions.rename(sessionId, title),
  setSessionPinned: (sessionId: string, pinned: boolean): Promise<void> =>
    window.swarm.sessions.setPinned(sessionId, pinned),
  reorderSessions: (orderedIds: string[]): Promise<void> => window.swarm.sessions.reorder(orderedIds),
  listMemory: (namespace?: string): Promise<MemoryView[]> => window.swarm.memory.list(namespace),
  getUsageStats: (rangeDays: number): Promise<UsageStats> => window.swarm.usage.get(rangeDays),
}
