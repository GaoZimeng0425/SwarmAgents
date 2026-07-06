// Live per-agent activity map, derived from all runs + sessions.

import { useMemo } from 'react'

import { useRuns } from '@/hooks/use-runs'
import { buildAgentActivity } from '@/lib/formations/build-agent-activity'
import { useSessionsStore } from '@/stores/sessions'

export function useAgentActivity() {
  const runs = useRuns()
  const sessions = useSessionsStore((s) => s.sessions)
  return useMemo(() => buildAgentActivity(runs, sessions), [runs, sessions])
}
