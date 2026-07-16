// Per-agent activity map, derived from sessions. Live per-message activity is
// deferred on the wire-v3 rails (no global cross-session message cache); this
// builds from sessions alone until per-session views feed it in a later phase.

import { useMemo } from 'react'

import { buildAgentActivity } from '@/lib/formations/build-agent-activity'
import { useSessionsStore } from '@/stores/sessions'

export function useAgentActivity() {
  const sessions = useSessionsStore((s) => s.sessions)
  return useMemo(() => buildAgentActivity([], sessions), [sessions])
}
