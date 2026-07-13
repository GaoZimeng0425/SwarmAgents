import { useMemo } from 'react'
import { Background, Controls, type Edge, type Node, ReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { useDelegationPlan } from '../../hooks/use-delegation-plan'
import { useMessages } from '../../hooks/use-messages'
import { PlanItemNode } from './PlanItemNode'
import { RunNode, type RunNodeData } from './RunNode'

const nodeTypes = { planItem: PlanItemNode, run: RunNode }

export function OrchestrationGraph() {
  const planState = useDelegationPlan()
  const messages = useMessages()

  const { nodes, edges } = useMemo(() => {
    if (!planState) return { nodes: [], edges: [] }

    const nodes: Node[] = []
    const edges: Edge[] = []

    // plan-item nodes (top row)
    const planItems = [...planState.values()]
    planItems.forEach((item, i) => {
      nodes.push({
        id: `plan-${item.id}`,
        type: 'planItem',
        position: { x: i * 200, y: 0 },
        data: { item },
      })
      // dependsOn edges
      for (const dep of item.dependsOn) {
        edges.push({ id: `dep-${dep}-${item.id}`, source: `plan-${dep}`, target: `plan-${item.id}`, animated: true })
      }
    })

    // run nodes (bottom row) — messages with parentMessageId form the delegation tree
    const runMessages = messages.filter((m) => m.parentMessageId)
    runMessages.forEach((m, i) => {
      const runData: RunNodeData = {
        messageId: m.id,
        summary: m.summary ?? '',
        agentType: m.agentDefId,
        parentMessageId: m.parentMessageId,
      }
      nodes.push({
        id: `run-${m.id}`,
        type: 'run',
        position: { x: i * 200, y: 250 },
        data: runData,
      })
      // parent→child edge
      edges.push({ id: `pc-${m.parentMessageId}-${m.id}`, source: `run-${m.parentMessageId}`, target: `run-${m.id}` })
    })

    // TODO: item→run edges via tool.call.args.itemId (requires reading message.progress events)
    // This is a follow-up refinement; initial version shows plan DAG + run tree separately.

    return { nodes, edges }
  }, [planState, messages])

  if (!planState || planState.size === 0) return null

  return (
    <div className="h-[400px] w-full rounded-lg border bg-white">
      <ReactFlow edges={edges} fitView nodes={nodes} nodeTypes={nodeTypes}>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}
