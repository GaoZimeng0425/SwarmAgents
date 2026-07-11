// Pure markdown builder for session exports. Turns a session's MessageEvent stream
// into a human-readable transcript: messages as bold role lines, tool calls as
// fenced code, errors as blockquotes. Child messages nest under their parent. Pure;
// unit-tested. The file-write wrapper lives in session-service.
//
// Data shape: each MessageEvent's `event` is a UIEvent. The transcript content
// (llm.message / tool.call / reasoning / error) lives INSIDE message.progress
// events as a TaskEvent payload (`event.event`). message.tool_call / message.error /
// message.complete are also rendered at the message level. Pure; unit-tested.

import type { MessageEvent, TaskEvent, UIEvent } from '@swarm/protocol'

const PAYLOAD_LIMIT = 2000

/**
 * Build a markdown transcript from a session's message-event rows. Rows must be in
 * insertion order (as returned by ConversationStore.getMessageEvents). Top-level
 * messages become `##` sections; child messages indent their contents.
 */
export function buildMarkdown(rows: MessageEvent[]): string {
  const byRun = new Map<string, MessageEvent[]>()
  const parentOf = new Map<string, string | null>()
  const promptByRun = new Map<string, string>()
  const order: string[] = []
  for (const r of rows) {
    if (!byRun.has(r.messageId)) {
      byRun.set(r.messageId, [])
      order.push(r.messageId)
      parentOf.set(r.messageId, r.parentMessageId)
    }
    // Capture the prompt from message.created for the section heading.
    if (r.event.kind === 'message.created') promptByRun.set(r.messageId, r.event.prompt)
    byRun.get(r.messageId)!.push(r)
  }

  const lines: string[] = ['# SwarmAgents Session Export', '']

  const renderRun = (messageId: string, depth: number): void => {
    const events = byRun.get(messageId) ?? []
    const prefix = '  '.repeat(depth)
    const heading = '#'.repeat(Math.min(depth + 2, 6))
    lines.push(`${prefix}${heading} ${promptByRun.get(messageId) ?? messageId}`, '')
    for (const { event } of events) {
      for (const body of renderEvent(event)) {
        lines.push(`${prefix}${body}`, '')
      }
    }
  }

  // Render top-level runs first; their children appear nested inline.
  const rendered = new Set<string>()
  for (const messageId of order) {
    if (parentOf.get(messageId) !== null) continue // child — rendered by parent
    renderRun(messageId, 0)
    rendered.add(messageId)
    for (const child of order) {
      if (parentOf.get(child) === messageId && !rendered.has(child)) {
        renderRun(child, 1)
        rendered.add(child)
      }
    }
  }

  return lines.join('\n').trimEnd() + '\n'
}

// Yields 0..n markdown lines for a single UIEvent. message.progress events unwrap
// their nested TaskEvent and render its content; message-level lifecycle events
// render directly. Returns empty for events that aren't transcript-worthy.
function renderEvent(e: UIEvent): string[] {
  switch (e.kind) {
    case 'message.progress':
      return renderTaskEvent(e.event)
    case 'message.tool_call':
      return ['```json', truncate(`tool: ${e.tool}\nargs: ${stringify(e.args)}`), '```']
    case 'message.error':
      return [`> ⚠️ ${e.error.message} (${e.error.code})`]
    case 'message.complete':
      return e.summary ? [`_✓ ${truncate(e.summary)}_`] : []
    case 'message.created':
    case 'message.dispatched':
    case 'message.usage':
    case 'message.plan':
    case 'message.delegation_plan':
    case 'message.spawned':
    case 'message.permission_request':
      return [] // lifecycle/plumbing — reflected in headings, not transcript body
    default:
      return [] // session.*/memory.*/gmail.* — not part of a message transcript
  }
}

function renderTaskEvent(e: TaskEvent): string[] {
  switch (e.kind) {
    case 'llm.message': {
      const role = e.role === 'user' ? 'You' : e.role === 'assistant' ? 'Agent' : 'Tool'
      return [`**${role}:** ${truncate(stringify(e.content))}`]
    }
    case 'tool.call':
      return ['```json', truncate(`tool: ${e.tool}\nserver: ${e.server}\nargs: ${stringify(e.args)}`), '```']
    case 'tool.result':
      return [] // results are noise in an export; the call + next message suffice
    case 'error':
      return [`> ⚠️ ${e.error.message} (${e.error.code})`]
    case 'permission':
      return [] // intra-run plumbing; not transcript-worthy
    case 'reasoning':
      return [] // model-private
    case 'handoff':
      return [] // sub-run plumbing
    default:
      return []
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function truncate(text: string): string {
  if (text.length <= PAYLOAD_LIMIT) return text
  return `${text.slice(0, PAYLOAD_LIMIT)}\n\n… (truncated, ${text.length - PAYLOAD_LIMIT} chars omitted)`
}
