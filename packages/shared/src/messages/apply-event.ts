import type { Attachment, ConsumedResources, MessageWireEvent, PlanTodo, UIEvent } from '@swarm/protocol'

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
  /** Set when this message is a spawned sub-agent (links to its parent). */
  parentMessageId?: string
  /** Sub-agent definition id, used to label the subagent block. */
  agentDefId?: string
  /** Session-scoped monotonic order; stamped once from the message.created event. */
  order: number
  events: UIEvent[]
}

function setStatus(message: MessageRecord, status: MessageStatus): MessageRecord {
  return { ...message, status }
}

// Type guard: only message.* wire events carry a swarm messageId + sessionId.
// gmail.analysis* events also carry a `messageId`, but it's a Gmail email id
// (no sessionId), so a plain `'messageId' in e` check would mis-fire on them.
function isMessageWireEvent(e: UIEvent): e is MessageWireEvent {
  return typeof e.kind === 'string' && e.kind.startsWith('message.')
}

export function applyEvent(messages: MessageRecord[], e: UIEvent): MessageRecord[] {
  // Only message.* events drive a MessageRecord; session.*/gmail.*/*.changed do
  // not and are ignored. The kind-based guard also narrows `e` to MessageWireEvent
  // (sessionId + seq always present), so the stub/created paths stay type-safe.
  if (!isMessageWireEvent(e)) return messages
  const messageId = e.messageId

  if (e.kind === 'message.created') {
    const created: MessageRecord = {
      id: e.messageId,
      sessionId: e.sessionId,
      prompt: e.prompt,
      status: 'pending',
      summary: null,
      createdAt: e.ts,
      attachments: e.attachments ?? [],
      parentMessageId: e.parentMessageId,
      agentDefId: e.agentDefId,
      order: e.seq,
      events: [e],
    }
    const without = messages.filter((r) => r.id !== e.messageId)
    return [created, ...without]
  }

  // Event for a message we have no record of (e.g. forwarded out of order, or a
  // sub-agent whose message.created was missed). Create a stub and then fall
  // through to apply this event's semantics — crucially so a terminal event
  // (complete/error) doesn't leave the stub stuck 'running', which would keep
  // the composer in a loading state forever.
  let workingMessages = messages
  let idx = messages.findIndex((r) => r.id === messageId)
  if (idx === -1) {
    const stub: MessageRecord = {
      id: messageId,
      sessionId: e.sessionId,
      prompt: '(unknown message)',
      status: 'running',
      summary: null,
      createdAt: e.ts,
      attachments: [],
      order: e.seq,
      events: [],
    }
    workingMessages = [stub, ...messages]
    idx = 0
  }

  let updated: MessageRecord = { ...workingMessages[idx], events: [...workingMessages[idx].events, e] }

  switch (e.kind) {
    case 'message.dispatched':
      updated = setStatus(updated, 'running')
      break
    case 'message.complete':
      updated = setStatus({ ...updated, summary: e.summary }, 'completed')
      break
    case 'message.error':
      updated = setStatus(updated, e.error.code === 'cancelled' ? 'cancelled' : 'failed')
      break
    case 'message.usage':
      updated = {
        ...updated,
        used: e.used,
      }
      break
    case 'message.plan':
      updated = { ...updated, plan: e.todos }
      break
    case 'message.permission_request':
      updated = setStatus(updated, 'awaiting_user')
      break
    case 'message.progress':
      // A streamed progress event means the message resumed: a message parked
      // on a permission prompt is executing again once the operator decides
      // (the granted tool runs, or the model keeps going after a deny). Nothing
      // else resets it, so without this the message stays 'awaiting_user' for
      // the rest of the message and the composer's submit button never leaves
      // its stop state until the terminal event. Only a parked message flips; a
      // live message is untouched.
      if (updated.status === 'awaiting_user') updated = setStatus(updated, 'running')
      break
    // message.spawned is append-only: the parent→child linkage rides
    // parentMessageId on the child's message.created, so here we only record
    // the event on the parent.
    default:
      break
  }

  const next = [...workingMessages]
  next[idx] = updated
  return next
}
