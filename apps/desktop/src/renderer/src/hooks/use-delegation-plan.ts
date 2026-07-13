import { useMemo } from 'react'
import type { DelegationItem } from '@swarm/protocol'
import { applyDelegationPlan, applyDelegationUpdate, type PlanItemState } from '@swarm/shared'

import { useMessages } from './use-messages'

/**
 * Derive the session-level delegation plan state from the message cache.
 * planState is event-replay derived: start from the last delegation_plan,
 * then apply all delegation_updates chronologically.
 */
export function useDelegationPlan(): Map<string, PlanItemState> | null {
  const messages = useMessages()

  return useMemo(() => {
    // Find the last message carrying a delegation_plan
    let planItems: DelegationItem[] | null = null
    let planMessageId: string | null = null
    for (const m of messages) {
      if (m.delegationPlan && m.delegationPlan.length > 0) {
        planItems = m.delegationPlan
        planMessageId = m.id
      }
    }
    if (!planItems || !planMessageId) return null

    let state = applyDelegationPlan(undefined, planItems)
    // Apply all delegation_updates from the plan message onward
    for (const m of messages) {
      if (m.delegationUpdates) {
        for (const u of m.delegationUpdates) {
          state = applyDelegationUpdate(state, u)
        }
      }
    }
    return state
  }, [messages])
}
