import type { PlanItemState } from '@swarm/shared'
import { Handle, Position } from '@xyflow/react'

const statusColors: Record<string, string> = {
  pending: 'bg-gray-200 border-gray-400',
  running: 'bg-blue-100 border-blue-500',
  completed: 'bg-green-100 border-green-500',
  failed: 'bg-red-100 border-red-500',
  cancelled: 'bg-gray-100 border-gray-300',
}

export function PlanItemNode({ data }: { data: { item: PlanItemState } }) {
  const { item } = data
  const color = statusColors[item.status] ?? statusColors.pending
  return (
    <div className={`rounded-md border-2 px-3 py-2 ${color}`}>
      <Handle position={Position.Top} type="target" />
      <div className="font-mono text-gray-500 text-xs">{item.id}</div>
      <div className="line-clamp-2 font-medium text-sm">{item.prompt}</div>
      <div className="mt-1 text-gray-500 text-xs">{item.status}</div>
      <Handle position={Position.Bottom} type="source" />
    </div>
  )
}
