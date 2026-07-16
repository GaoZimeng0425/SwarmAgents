// Pure markdown builder for session exports. Turns a session's finalized entry
// log (session_entries) into a human-readable transcript: user turns become `##`
// section headings, assistant text becomes bold Agent lines, tool calls become
// fenced JSON, and plan / delegation custom entries render as their own blocks.
// Usage (and other app-data) custom entries are skipped. Pure; unit-tested. The
// file-write wrapper lives in session-service.
import type { EntryRow, SessionEntry } from '@swarm/protocol'

const PAYLOAD_LIMIT = 2000

type ContentPart = { type?: string; text?: string; name?: string; input?: unknown }

/** Concatenate the text content of a pi message (string, or text parts of an array). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c): c is ContentPart => (c as ContentPart)?.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
  }
  return ''
}

/** Tool-call parts of an assistant message (pi uses 'tool_use'; tolerate 'tool_call'). */
function toolCallsOf(content: unknown): ContentPart[] {
  if (!Array.isArray(content)) return []
  return content.filter((c): c is ContentPart => {
    const t = (c as ContentPart)?.type
    return t === 'tool_use' || t === 'tool_call'
  })
}

/**
 * Build a markdown transcript from a session's finalized entries in log order.
 * Linear history (spec D5): table order IS the transcript order.
 */
export function buildMarkdown(rows: EntryRow[]): string {
  const lines: string[] = ['# SwarmAgents Session Export', '']
  for (const { entry } of rows) {
    for (const body of renderEntry(entry)) lines.push(body, '')
  }
  return lines.join('\n').trimEnd() + '\n'
}

function renderEntry(entry: SessionEntry): string[] {
  if (entry.type === 'message') {
    const message = entry.message as { role?: string; content?: unknown }
    if (message.role === 'user') {
      const text = textOf(message.content)
      return text ? [`## ${truncate(text)}`] : []
    }
    if (message.role === 'assistant') {
      const out: string[] = []
      const text = textOf(message.content)
      if (text) out.push(`**Agent:** ${truncate(text)}`)
      for (const call of toolCallsOf(message.content)) {
        out.push('```json', truncate(`tool: ${call.name ?? ''}\nargs: ${stringify(call.input)}`), '```')
      }
      return out
    }
    // tool results are noise in an export; the call + next message suffice.
    return []
  }
  if (entry.type === 'custom') {
    if (entry.customType === 'plan') {
      const todos = (entry.data as { todos?: Array<{ content?: string; status?: string }> } | undefined)?.todos ?? []
      if (todos.length === 0) return []
      return ['**Plan:**', ...todos.map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content ?? ''}`)]
    }
    if (entry.customType?.startsWith('delegation')) {
      return [`_→ ${entry.customType}: ${truncate(stringify(entry.data))}_`]
    }
    // usage / other app-data: not transcript-worthy.
    return []
  }
  return []
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
