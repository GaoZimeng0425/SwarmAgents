// Pure markdown builder for session exports. Turns a session's RunEvent stream
// into a human-readable transcript: messages as bold role lines, tool calls as
// fenced code, errors as blockquotes. Child runs nest under their parent. Pure;
// unit-tested. The file-write wrapper lives in session-service.
//
// Data shape: each RunEvent's `event` is a UIEvent. The transcript content
// (llm.message / tool.call / reasoning / error) lives INSIDE run.progress
// events as a TaskEvent payload (`event.event`). run.tool_call / run.error /
// run.complete are also rendered at the run level. Pure; unit-tested.

import type { RunEvent, TaskEvent, UIEvent } from '@swarm/protocol'

const PAYLOAD_LIMIT = 2000

/**
 * Build a markdown transcript from a session's run-event rows. Rows must be in
 * insertion order (as returned by ConversationStore.getRunEvents). Top-level
 * runs become `##` sections; child runs indent their contents.
 */
export function buildMarkdown(rows: RunEvent[]): string {
  const byRun = new Map<string, RunEvent[]>()
  const parentOf = new Map<string, string | null>()
  const promptByRun = new Map<string, string>()
  const order: string[] = []
  for (const r of rows) {
    if (!byRun.has(r.runId)) {
      byRun.set(r.runId, [])
      order.push(r.runId)
      parentOf.set(r.runId, r.parentRunId)
    }
    // Capture the goal from run.created for the section heading.
    if (r.event.kind === 'run.created') promptByRun.set(r.runId, r.event.prompt)
    byRun.get(r.runId)!.push(r)
  }

  const lines: string[] = ['# SwarmAgents Session Export', '']

  const renderRun = (runId: string, depth: number): void => {
    const events = byRun.get(runId) ?? []
    const prefix = '  '.repeat(depth)
    const heading = '#'.repeat(Math.min(depth + 2, 6))
    lines.push(`${prefix}${heading} ${promptByRun.get(runId) ?? runId}`, '')
    for (const { event } of events) {
      for (const body of renderEvent(event)) {
        lines.push(`${prefix}${body}`, '')
      }
    }
  }

  // Render top-level runs first; their children appear nested inline.
  const rendered = new Set<string>()
  for (const runId of order) {
    if (parentOf.get(runId) !== null) continue // child — rendered by parent
    renderRun(runId, 0)
    rendered.add(runId)
    for (const child of order) {
      if (parentOf.get(child) === runId && !rendered.has(child)) {
        renderRun(child, 1)
        rendered.add(child)
      }
    }
  }

  return lines.join('\n').trimEnd() + '\n'
}

// Yields 0..n markdown lines for a single UIEvent. run.progress events unwrap
// their nested TaskEvent and render its content; run-level lifecycle events
// render directly. Returns empty for events that aren't transcript-worthy.
function renderEvent(e: UIEvent): string[] {
  switch (e.kind) {
    case 'run.progress':
      return renderTaskEvent(e.event)
    case 'run.tool_call':
      return ['```json', truncate(`tool: ${e.tool}\nargs: ${stringify(e.args)}`), '```']
    case 'run.error':
      return [`> ⚠️ ${e.error.message} (${e.error.code})`]
    case 'run.complete':
      return e.summary ? [`_✓ ${truncate(e.summary)}_`] : []
    case 'run.created':
    case 'run.dispatched':
    case 'run.usage':
    case 'run.plan':
    case 'run.delegation_plan':
    case 'run.spawned':
    case 'run.permission_request':
      return [] // lifecycle/plumbing — reflected in headings, not transcript body
    default:
      return [] // session.*/memory.*/gmail.* — not part of a run transcript
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
