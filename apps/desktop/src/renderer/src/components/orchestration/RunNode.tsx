import { Handle, Position } from '@xyflow/react'

export type RunNodeData = {
  messageId: string
  summary: string
  agentType?: string
  parentMessageId?: string
}

export function RunNode({ data }: { data: RunNodeData }) {
  return (
    <div className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2">
      <Handle position={Position.Top} type="target" />
      <div className="font-mono text-indigo-400 text-xs">{data.agentType ?? 'default'}</div>
      <div className="line-clamp-2 text-sm">{data.summary || '(no summary)'}</div>
      <Handle position={Position.Bottom} type="source" />
    </div>
  )
}
