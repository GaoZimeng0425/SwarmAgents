// apps/desktop/src/renderer/src/components/workspace/approval-tab.tsx
// Approval tab — current session's pending permission prompts, reusing PermissionCard.

import type { PermissionDecision } from '@swarm/protocol'

import { PermissionCard } from '@/components/permission-card'
import { usePermissionStore } from '@/stores/permission'

type Props = {
  sessionId: string | null
  onDecide: (actionId: string, decision: PermissionDecision) => void
}

export function ApprovalTab({ sessionId, onDecide }: Props): React.JSX.Element {
  const queue = usePermissionStore((s) => s.queue)
  const pending = sessionId ? queue.filter((p) => p.sessionId === sessionId) : []
  if (pending.length === 0) {
    return <div className="p-4 text-muted-foreground text-sm">暂无待审批</div>
  }
  return (
    <div className="cmdscroll flex-1 space-y-2 overflow-y-auto p-3">
      {pending.map((p, i) => (
        <PermissionCard autoFocusDeny={i === 0} key={p.actionId} onDecide={onDecide} prompt={p} />
      ))}
    </div>
  )
}
