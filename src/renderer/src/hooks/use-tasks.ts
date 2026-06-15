import type { PermissionDecision } from '@shared/types/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

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

/** Submit a goal to the currently-selected session, creating one if needed. */
export function useSubmitGoal() {
  return useMutation({
    mutationFn: async (goal: string) => {
      let sessionId = useSessionsStore.getState().selectedSessionId
      if (!sessionId) {
        const created = await swarmApi.createSession()
        sessionId = created.sessionId
        useSessionsStore.getState().select(sessionId)
      }
      return swarmApi.submitGoal(sessionId, goal)
    },
  })
}

/** Load the session list on mount and select the newest. */
export function useLoadSessions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const sessions = await swarmApi.listSessions()
      useSessionsStore.getState().setSessions(sessions)
      return sessions
    },
    onSuccess: async (sessions) => {
      const current = useSessionsStore.getState().selectedSessionId
      if (!current && sessions[0]) {
        useSessionsStore.getState().select(sessions[0].id)
        await hydrateSession(qc, sessions[0].id)
      }
    },
  })
}

/** Replay a session's stored tasks into the tasks cache (idempotent merge by id). */
export async function hydrateSession(
  qc: ReturnType<typeof useQueryClient>,
  sessionId: string,
): Promise<void> {
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
