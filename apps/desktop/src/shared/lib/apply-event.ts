// v2 message-record shape, kept as a TYPE ONLY. The event-reduction reducer and
// the message.* wire it consumed are gone (v3 routes render from SessionView /
// session entries). A handful of dashboard/workspace/scheduled components still
// reference this type in their signatures but are fed empty arrays at runtime on
// the entry rails — restoring real data for them is P2+ (see task-9 report).
import type {
  Artifact,
  Attachment,
  ConsumedResources,
  DelegationItem,
  DelegationItemStatus,
  PlanTodo,
  UIEvent,
} from '@swarm/protocol'

export type MessageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'awaiting_user' | 'cancelled'

export type MessageRecord = {
  id: string
  sessionId: string
  prompt: string
  status: MessageStatus
  summary: string | null
  createdAt: number
  attachments: Attachment[]
  used?: ConsumedResources
  plan?: PlanTodo[]
  delegationPlan?: DelegationItem[]
  delegationUpdates?: Array<{ itemId: string; status: DelegationItemStatus; result: Artifact[] }>
  parentMessageId?: string
  agentDefId?: string
  order: number
  events: UIEvent[]
}
