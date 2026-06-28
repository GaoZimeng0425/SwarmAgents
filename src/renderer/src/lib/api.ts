import type { AgentDefinition, AgentListItem, AgentMutationResult } from '@shared/types/agent'
import type { BiliListResult, BiliLoginStatus, BiliProcessResult } from '@shared/types/bilibili'
import type { MemoryView } from '@shared/types/memory'
import type { Attachment, Task, TaskOptions } from '@shared/types/task'
import type { TrendingPeriod, TrendingRepo } from '@shared/types/trending'
import type {
  CronJobSummary,
  CronRun,
  PermissionDecision,
  ScheduledTask,
  SessionSettings,
  SessionSummary,
  SubmitGoalResult,
  UIEvent,
} from '@shared/types/ui'
import type { UsageStats } from '@shared/types/usage'

export const swarmApi = {
  submitGoal: (
    sessionId: string,
    goal: string,
    attachments?: Attachment[],
    options?: TaskOptions
  ): Promise<SubmitGoalResult> => window.swarm.submitGoal(sessionId, goal, attachments, options),
  cancelTask: (sessionId: string, taskId: string): Promise<void> => window.swarm.cancelTask(sessionId, taskId),
  interruptWith: (sessionId: string, taskId: string): Promise<void> => window.swarm.interruptWith(sessionId, taskId),
  decidePermission: (sessionId: string, actionId: string, decision: PermissionDecision): Promise<void> =>
    window.swarm.decidePermission(sessionId, actionId, decision),
  subscribeEvents: (cb: (e: UIEvent) => void): (() => void) => window.swarm.subscribeEvents(cb),
  onNavigateToSession: (cb: (sessionId: string) => void): (() => void) => window.swarm.onNavigateToSession(cb),
  onNavigateToSettings: (cb: (route: string) => void): (() => void) => window.swarm.onNavigateToSettings(cb),
  consumePendingDeepLink: (): Promise<{ sessionId: string } | null> => window.swarm.consumePendingDeepLink(),
  listSessions: (): Promise<SessionSummary[]> => window.swarm.sessions.list(),
  createSession: (): Promise<{ sessionId: string }> => window.swarm.sessions.create(),
  getSessionTasks: (sessionId: string): Promise<Task[]> => window.swarm.sessions.getTasks(sessionId),
  deleteSession: (sessionId: string): Promise<void> => window.swarm.sessions.delete(sessionId),
  renameSession: (sessionId: string, title: string): Promise<void> => window.swarm.sessions.rename(sessionId, title),
  setSessionPinned: (sessionId: string, pinned: boolean): Promise<void> =>
    window.swarm.sessions.setPinned(sessionId, pinned),
  updateSessionSettings: (sessionId: string, settings: SessionSettings): Promise<void> =>
    window.swarm.sessions.updateSettings(sessionId, settings),
  reorderSessions: (orderedIds: string[]): Promise<void> => window.swarm.sessions.reorder(orderedIds),
  listMemory: (namespace?: string): Promise<MemoryView[]> => window.swarm.memory.list(namespace),
  listAgents: (): Promise<AgentListItem[]> => window.swarm.agents.list(),
  saveAgent: (def: AgentDefinition): Promise<AgentMutationResult> => window.swarm.agents.save(def),
  removeAgent: (id: string): Promise<AgentMutationResult> => window.swarm.agents.remove(id),
  restoreDefaultAgents: (): Promise<AgentMutationResult> => window.swarm.agents.restoreDefaults(),
  getUsageStats: (rangeDays: number): Promise<UsageStats> => window.swarm.usage.get(rangeDays),
  getTrendingRepos: (period: TrendingPeriod, language: string): Promise<TrendingRepo[]> =>
    window.swarm.trending.get(period, language),
  getBilibiliStatus: (): Promise<BiliLoginStatus> => window.swarm.bilibili.status(),
  bilibiliLogin: (): Promise<BiliLoginStatus> => window.swarm.bilibili.login(),
  bilibiliLogout: (): Promise<void> => window.swarm.bilibili.logout(),
  getBilibiliList: (): Promise<BiliListResult> => window.swarm.bilibili.list(),
  bilibiliProcess: (bvid: string): Promise<BiliProcessResult> => window.swarm.bilibili.process(bvid),
  bilibiliOpen: (bvid: string): Promise<void> => window.swarm.bilibili.open(bvid),
  listCronJobsForSession: (sessionId: string): Promise<CronJobSummary[]> => window.swarm.cron.listForSession(sessionId),
  listAllCronJobs: (): Promise<ScheduledTask[]> => window.swarm.cron.listAll(),
  listAllCronRuns: (): Promise<CronRun[]> => window.swarm.cron.listAllRuns(),
  cancelCronJob: (id: string): Promise<void> => window.swarm.cron.cancel(id),
}
