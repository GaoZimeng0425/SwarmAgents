import type { CronJobSummary, ScheduledTask } from '@shared/types/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'

export const CRON_SESSION_KEY = (sessionId: string): unknown[] => ['cron', 'session', sessionId]
export const CRON_ALL_KEY: unknown[] = ['cron', 'all']

// Refetch while the panel is visible so jobs the agent creates/fires via tools
// surface without a dedicated event channel.
const REFETCH_MS = 20_000

export function useSessionCronJobs(sessionId: string | null, enabled: boolean) {
  return useQuery<CronJobSummary[]>({
    queryKey: CRON_SESSION_KEY(sessionId ?? ''),
    queryFn: () => swarmApi.listCronJobsForSession(sessionId as string),
    enabled: enabled && !!sessionId,
    refetchInterval: enabled ? REFETCH_MS : false,
  })
}

export function useAllCronJobs() {
  return useQuery<ScheduledTask[]>({
    queryKey: CRON_ALL_KEY,
    queryFn: () => swarmApi.listAllCronJobs(),
    refetchInterval: REFETCH_MS,
  })
}

export function useCancelCronJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => swarmApi.cancelCronJob(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cron'] })
    },
  })
}
