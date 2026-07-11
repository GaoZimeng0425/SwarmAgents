// Live per-agent activity map, derived from all messages + sessions.

import { useMemo } from 'react'

import { useMessages } from '@/hooks/use-messages'
import { buildAgentActivity } from '@/lib/formations/build-agent-activity'
import { useSessionsStore } from '@/stores/sessions'

export function useAgentActivity() {
  const messages = useMessages()
  const sessions = useSessionsStore((s) => s.sessions)
  return useMemo(() => buildAgentActivity(messages, sessions), [messages, sessions])
}
