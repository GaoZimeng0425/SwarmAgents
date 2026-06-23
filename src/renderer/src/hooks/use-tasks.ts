import type { PermissionDecision } from '@shared/types/ui'
import { useMutation, useQuery, type useQueryClient } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'
import type { TaskRecord } from '@/lib/apply-event'
import { tasksToRecords } from '@/lib/replay'
import { usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

export const TASKS_KEY = ['tasks'] as const

export function useTasks(): TaskRecord[] {
  const { data } = useQuery<TaskRecord[]>({
    queryKey: TASKS_KEY,
    queryFn: () => [],
    staleTime: Number.POSITIVE_INFINITY,
  })
  return data ?? []
}

/**
 * Submit a goal to the currently-selected session, creating one if needed.
 * Returns the resolved sessionId so callers landing on `/` (no selection yet)
 * can navigate to the freshly-created session.
 */
export function useSubmitGoal() {
  return useMutation({
    mutationFn: async ({
      goal,
      attachments,
      options,
    }: {
      goal: string
      attachments?: import('@shared/types/task').Attachment[]
      options?: import('@shared/types/task').TaskOptions
    }): Promise<{ sessionId: string }> => {
      let sessionId = useSessionsStore.getState().selectedSessionId
      if (!sessionId) {
        const created = await swarmApi.createSession()
        sessionId = created.sessionId
        useSessionsStore.getState().select(sessionId)
      }
      await swarmApi.submitGoal(sessionId, goal, attachments, options)
      return { sessionId }
    },
  })
}

/** Load the session list. The active session is driven by the route, not here. */
export function useLoadSessions() {
  return useMutation({
    mutationFn: async () => {
      const sessions = await swarmApi.listSessions()
      useSessionsStore.getState().setSessions(sessions)
      return sessions
    },
  })
}

/** Replay a session's stored tasks into the tasks cache (idempotent merge by id). */
export async function hydrateSession(qc: ReturnType<typeof useQueryClient>, sessionId: string): Promise<void> {
  const tasks = await swarmApi.getSessionTasks(sessionId)
  const records = tasksToRecords(sessionId, tasks)
  qc.setQueryData<TaskRecord[]>(TASKS_KEY, (prev = []) => {
    const known = new Set(prev.map((t) => t.id))
    const fresh = records.filter((r) => !known.has(r.id))
    return [...fresh, ...prev]
  })
}

export function useDecidePermission() {
  const remove = usePermissionStore((s) => s.remove)
  return useMutation({
    mutationFn: ({
      sessionId,
      actionId,
      decision,
    }: {
      sessionId: string
      actionId: string
      decision: PermissionDecision
    }) => swarmApi.decidePermission(sessionId, actionId, decision),
    onSuccess: (_, { actionId }) => remove(actionId),
  })
}

/** Cancel an in-flight task (aborts the agent run server-side). */
export function useCancelTask() {
  return useMutation({
    mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) =>
      swarmApi.cancelTask(sessionId, taskId),
  })
}
