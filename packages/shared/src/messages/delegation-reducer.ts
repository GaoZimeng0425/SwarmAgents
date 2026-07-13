import type { Artifact, DelegationItem, DelegationItemStatus } from '@swarm/protocol'

export type PlanItemState = DelegationItem & {
  status: DelegationItemStatus
  result: Artifact[]
}

/** A delegation_plan event replaces the entire plan state (full snapshot). */
export function applyDelegationPlan(
  prev: Map<string, PlanItemState> | undefined,
  plan: DelegationItem[]
): Map<string, PlanItemState> {
  const next = new Map<string, PlanItemState>()
  for (const it of plan) {
    next.set(it.id, { ...it, status: 'pending', result: [] })
  }
  return next
}

/** A delegation_update event merges one item: status overwrites, result overwrites (not append). */
export function applyDelegationUpdate(
  state: Map<string, PlanItemState>,
  update: { itemId: string; status: DelegationItemStatus; result: Artifact[] }
): Map<string, PlanItemState> {
  const item = state.get(update.itemId)
  if (!item) return state // unknown itemId = temporary delegation, no-op
  const next = new Map(state)
  next.set(update.itemId, { ...item, status: update.status, result: update.result })
  return next
}

/** Replay a sorted event stream to rebuild planState (lazy-load / crash recovery). */
export function replayDelegationEvents(
  events: Array<{ kind: string; [k: string]: unknown }>
): Map<string, PlanItemState> {
  let state: Map<string, PlanItemState> | undefined
  for (const e of events) {
    if (e.kind === 'message.delegation_plan') {
      state = applyDelegationPlan(state, e.plan as DelegationItem[])
    } else if (e.kind === 'message.delegation_update') {
      if (!state) state = new Map()
      state = applyDelegationUpdate(state, {
        itemId: e.itemId as string,
        status: e.status as DelegationItemStatus,
        result: e.result as Artifact[],
      })
    }
  }
  return state ?? new Map()
}
