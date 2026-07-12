import { Button } from '@swarm/ui'

export type PermissionPrompt = {
  messageId: string
  actionId: string
  risk: string
  summary: string
}

export function PermissionCard({
  perm,
  onDecide,
}: {
  perm: PermissionPrompt
  onDecide: (decision: 'grant' | 'deny') => void
}): React.JSX.Element {
  return (
    <div className="mx-4 my-1 rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-3">
      <p className="font-medium text-sm text-yellow-700 dark:text-yellow-400">{perm.risk} 风险操作 · 需要审批</p>
      <p className="mt-1 text-muted-foreground text-xs">{perm.summary}</p>
      <div className="mt-2 flex gap-2">
        <Button onClick={() => onDecide('grant')} size="sm">
          批准
        </Button>
        <Button onClick={() => onDecide('deny')} size="sm" variant="outline">
          拒绝
        </Button>
      </div>
    </div>
  )
}
