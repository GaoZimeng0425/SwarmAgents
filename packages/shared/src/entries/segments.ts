import type { SessionEntry } from '@swarm/protocol'

import type { SessionView } from './session-view'

// Render segment union — mirrors apps/desktop/src/renderer/src/lib/task-segments.ts's
// Segment (user|assistant|reasoning|tool|event|error) so TranscriptCard-style
// components survive the switch from UIEvent[] to entry-based SessionView with
// minimal churn. `tool` additionally carries `toolCallId` when the entries/
// wire events supply one (entries don't always: legacy toolCall blocks can
// omit it, resolved by FIFO fallback below).
export type Segment =
  | { kind: 'user'; text: string; key: string; ts: number }
  | { kind: 'assistant'; text: string; key: string; ts: number }
  | { kind: 'reasoning'; text: string; key: string; ts: number }
  | {
      kind: 'tool'
      tool: string
      ok: boolean | null
      input: unknown
      output: string | null
      toolCallId?: string
      key: string
      ts: number
    }
  | {
      kind: 'event'
      label: string
      detail: string
      key: string
      ts: number
      // Set only for delegation events: lets the renderer re-key on the entry
      // and lazily load the spawned child session's own view (SubagentBlock).
      childSessionId?: string
      agentDefId?: string
    }
  | { kind: 'error'; label: 'error' | 'stopped'; detail: string; key: string; ts: number }

type ToolSegment = Extract<Segment, { kind: 'tool' }>

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

function contentBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return []
  return content.filter(
    (b): b is Record<string, unknown> => typeof b === 'object' && b !== null && typeof b.type === 'string'
  )
}

/** Defensive text extraction: content is either a plain string or a block array (text blocks joined, others ignored). */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  return contentBlocks(content)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v ?? null)
  } catch {
    return String(v)
  }
}

function rowTs(entry: SessionEntry, rowId: number): number {
  const parsed = Date.parse(entry.timestamp)
  return Number.isNaN(parsed) ? rowId : parsed
}

// Known customType payloads (session-service.ts's appendCustomEntry call
// sites) get a labeled event; anything else still renders — generically
// labeled by its customType — instead of being silently dropped (the
// open-union bet, spec §3.2).
function customEventSegment(entry: Extract<SessionEntry, { type: 'custom' }>, key: string, ts: number): Segment {
  const data = asRecord(entry.data)
  switch (entry.customType) {
    case 'plan': {
      const todos = Array.isArray(data?.todos) ? data.todos.length : 0
      return { kind: 'event', label: 'plan', detail: `${todos} todo(s)`, key, ts }
    }
    case 'delegation': {
      const agentDefId = typeof data?.agentDefId === 'string' ? data.agentDefId : 'unknown'
      const prompt = typeof data?.prompt === 'string' ? data.prompt : ''
      const childSessionId = typeof data?.childSessionId === 'string' ? data.childSessionId : undefined
      return {
        kind: 'event',
        label: 'delegation',
        detail: `${agentDefId}: ${prompt}`,
        key,
        ts,
        childSessionId,
        agentDefId,
      }
    }
    case 'delegation_result': {
      const status = typeof data?.status === 'string' ? data.status : 'unknown'
      const summary = typeof data?.summary === 'string' ? data.summary : ''
      return { kind: 'event', label: 'delegation result', detail: `${status}: ${summary}`, key, ts }
    }
    default:
      return { kind: 'event', label: entry.customType, detail: safeStringify(entry.data), key, ts }
  }
}

/** Flatten a SessionView's finalized entries + live overlays into ordered render segments. Pure; unit-tested. */
export function buildSegments(view: SessionView): Segment[] {
  const out: Segment[] = []
  // Tool calls awaiting their toolResult entry. Keyed by toolCallId when the
  // toolCall block carries one; otherwise resolved FIFO (mirrors desktop's
  // task-segments.ts pairing logic for parallel/legacy tool calls).
  const pendingByCallId = new Map<string, ToolSegment>()
  const pendingFifo: ToolSegment[] = []
  const seenToolCallIds = new Set<string>()

  const pushAssistantText = (text: string, key: string, ts: number): void => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.kind === 'assistant') last.text += text
    else out.push({ kind: 'assistant', text, key, ts })
  }
  const pushReasoning = (text: string, key: string, ts: number): void => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.kind === 'reasoning') last.text += text
    else out.push({ kind: 'reasoning', text, key, ts })
  }

  for (const { rowId, entry } of view.entries) {
    const key = entry.id
    const ts = rowTs(entry, rowId)

    switch (entry.type) {
      case 'message': {
        const msg = asRecord(entry.message)
        const role = msg?.role
        if (role === 'user') {
          out.push({ kind: 'user', text: extractText(msg?.content), key, ts })
        } else if (role === 'assistant') {
          for (const block of contentBlocks(msg?.content)) {
            if (block.type === 'text' && typeof block.text === 'string') {
              pushAssistantText(block.text, key, ts)
            } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
              pushReasoning(block.thinking, key, ts)
            } else if (block.type === 'toolCall') {
              const id = typeof block.id === 'string' ? block.id : undefined
              const seg: ToolSegment = {
                kind: 'tool',
                tool: typeof block.name === 'string' ? block.name : 'unknown',
                ok: null,
                input: block.arguments,
                output: null,
                toolCallId: id,
                key: `${key}-${id ?? out.length}`,
                ts,
              }
              out.push(seg)
              if (id) {
                pendingByCallId.set(id, seg)
                seenToolCallIds.add(id)
              } else {
                pendingFifo.push(seg)
              }
            }
          }
        } else if (role === 'toolResult') {
          const toolCallId = typeof msg?.toolCallId === 'string' ? msg.toolCallId : undefined
          const byId = toolCallId ? pendingByCallId.get(toolCallId) : undefined
          const target = byId ?? pendingFifo.shift()
          if (byId && toolCallId) pendingByCallId.delete(toolCallId)
          const output = extractText(msg?.content) || safeStringify(msg?.content ?? null)
          const ok = !msg?.isError
          if (target) {
            target.ok = ok
            target.output = output
          } else {
            out.push({ kind: 'event', label: ok ? 'tool result' : 'tool error', detail: output, key, ts })
          }
        }
        break
      }

      case 'custom':
        out.push(customEventSegment(entry, key, ts))
        break

      case 'custom_message':
        if (entry.display)
          out.push({ kind: 'event', label: entry.customType, detail: safeStringify(entry.content), key, ts })
        break

      case 'model_change':
        out.push({ kind: 'event', label: 'model change', detail: `${entry.provider}/${entry.modelId}`, key, ts })
        break

      case 'thinking_level_change':
        out.push({ kind: 'event', label: 'thinking level change', detail: entry.thinkingLevel, key, ts })
        break

      case 'compaction':
        out.push({ kind: 'event', label: 'compaction', detail: entry.summary, key, ts })
        break

      default: {
        // Exhaustiveness check: a new SessionEntry variant must be handled above.
        const Exhaustive: never = entry
        void Exhaustive
      }
    }
  }

  // Streaming overlay: the in-flight assistant message renders as one
  // trailing assistant segment (thinking/toolCall blocks in a partial
  // message aren't final yet, so only its text is shown).
  if (view.streaming !== undefined) {
    const msg = asRecord(view.streaming)
    const text = extractText(msg?.content ?? view.streaming)
    if (text) out.push({ kind: 'assistant', text, key: 'streaming', ts: Date.now() })
  }

  // Pending tools not already represented by an open entry-based tool
  // segment (tool_execution_* wire events race the entry that finalizes the
  // assistant's toolCall block) render as trailing running tool segments.
  for (const [toolCallId, tool] of Object.entries(view.pendingTools)) {
    if (seenToolCallIds.has(toolCallId)) continue
    out.push({
      kind: 'tool',
      tool: tool.toolName,
      ok: null,
      // args is absent for an orphan update (start missed a gap) — render as
      // null, consistent with ok/output's "unknown yet" convention below.
      input: tool.args ?? null,
      output: tool.partialResult !== undefined ? safeStringify(tool.partialResult) : null,
      toolCallId,
      key: `pending-${toolCallId}`,
      ts: Date.now(),
    })
  }

  return out
}
