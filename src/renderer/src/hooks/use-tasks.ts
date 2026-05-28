import type { PermissionDecision } from '@shared/types/ui'
import { useMutation, useQuery } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'
import type { TaskRecord } from '@/lib/apply-event'
import { usePermissionStore } from '@/stores/permission'

export const TASKS_KEY = ['tasks'] as const

export function useTasks(): TaskRecord[] {
  const { data } = useQuery<TaskRecord[]>({
    queryKey: TASKS_KEY,
    queryFn: () => [],
    staleTime: Number.POSITIVE_INFINITY,
  })
  return data ?? []
}

export function useSubmitGoal() {
  return useMutation({ mutationFn: (goal: string) => swarmApi.submitGoal(goal) })
}

export function useDecidePermission() {
  const remove = usePermissionStore((s) => s.remove)
  return useMutation({
    mutationFn: ({ actionId, decision }: { actionId: string; decision: PermissionDecision }) =>
      swarmApi.decidePermission(actionId, decision),
    onSuccess: (_, { actionId }) => remove(actionId),
  })
}
