import { useMemo } from 'react'
import type { DelegationItem } from '@swarm/protocol'
import { applyDelegationPlan, applyDelegationUpdate, type PlanItemState } from '@swarm/shared'

import { useMessages } from './use-messages'

/**
 * Derive the delegation plan state for ONE session from the message cache.
 * planState is event-replay derived: start from the session's last
 * delegation_plan, then apply its delegation_updates chronologically.
 *
 * `sessionId` MUST be passed: useMessages() returns the global cache (every
 * hydrated session), so without the filter this hook would pick up another
 * session's plan. Returns null when no session is selected.
 */
export function useDelegationPlan(sessionId: string | null): Map<string, PlanItemState> | null {
  const messages = useMessages()

  return useMemo(() => {
    if (!sessionId) return null
    // Scope to this session only — the global cache holds messages from every
    // hydrated session, so an unfiltered scan would leak plans across sessions.
    const sessionMessages = messages.filter((m) => m.sessionId === sessionId)

    // Find the last message carrying a delegation_plan
    let planItems: DelegationItem[] | null = null
    let planMessageId: string | null = null
    for (const m of sessionMessages) {
      if (m.delegationPlan && m.delegationPlan.length > 0) {
        planItems = m.delegationPlan
        planMessageId = m.id
      }
    }
    if (!planItems || !planMessageId) return null

    let state = applyDelegationPlan(undefined, planItems)
    // Apply all delegation_updates from the plan message onward
    for (const m of sessionMessages) {
      if (m.delegationUpdates) {
        for (const u of m.delegationUpdates) {
          state = applyDelegationUpdate(state, u)
        }
      }
    }
    return state
  }, [messages, sessionId])
}
