import type { ConsumedResources } from '@swarm/protocol'
import type { SessionView } from '@swarm/shared'

// The pi AgentMessage.usage shape carried on assistant message entries. Only the
// fields we surface are typed; everything is optional/defensive since entries
// are opaque JSON that reach the renderer without re-validation.
type PiUsage = {
  totalTokens?: number
  cost?: { total?: number }
  cacheRead?: number
  cacheWrite?: number
}

function assistantUsage(view: SessionView): { usages: PiUsage[]; last: PiUsage | undefined } {
  const usages: PiUsage[] = []
  for (const { entry } of view.entries) {
    if (entry.type !== 'message') continue
    const msg = entry.message as { role?: string; usage?: PiUsage }
    if (msg.role !== 'assistant' || !msg.usage) continue
    usages.push(msg.usage)
  }
  return { usages, last: usages[usages.length - 1] }
}

/**
 * Usage shown inside a session, mixing two scopes deliberately so the figures
 * match the session list:
 *  - `tokens` / `cacheRead` / `cacheWrite` are the current context size — the
 *    live turn_end snapshot (view.usage) when present, else the latest assistant
 *    message's usage. A fill gauge, NOT a running total.
 *  - `usdCents` is cumulative across the session's assistant turns — "spent so
 *    far" — summed from each assistant message's pi cost.
 * Returns undefined when the session has produced no assistant usage yet.
 */
export function sessionDisplayUsage(view: SessionView): ConsumedResources | undefined {
  const { usages, last } = assistantUsage(view)
  if (usages.length === 0 && !view.usage) return undefined

  const usdCents = usages.reduce((sum, u) => sum + Math.round((u.cost?.total ?? 0) * 100), 0)
  const live = view.usage?.used
  return {
    tokens: view.usage?.contextTokens ?? last?.totalTokens ?? 0,
    cacheRead: live?.cacheRead ?? last?.cacheRead ?? 0,
    cacheWrite: live?.cacheWrite ?? last?.cacheWrite ?? 0,
    usdCents,
    calls: live?.calls ?? usages.length,
    wallMs: live?.wallMs ?? 0,
  }
}
