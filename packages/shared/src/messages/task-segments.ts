import type { MessageWireEvent, TaskEvent, UIEvent } from '@swarm/protocol'

import type { MessageRecord } from './apply-event'

// A render segment is one user/assistant/reasoning/tool/error/event block in
// the conversation timeline. Segments are produced by flattening a message's
// UIEvent[] so that consecutive assistant chunks coalesce into one bubble,
// tool calls pair with their results, etc.
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
      key: string
      ts: number
    }
  | { kind: 'event'; label: string; detail: string; key: string; ts: number }
  | { kind: 'error'; label: 'error' | 'stopped'; detail: string; key: string; ts: number }

function toolDetail(payload: unknown): string {
  const p = payload as { text?: string } | undefined
  return typeof p?.text === 'string' ? p.text : JSON.stringify(payload ?? {}, null, 2)
}

function contentToString(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

/**
 * Flatten a message's UIEvent[] into ordered render segments.
 *
 * Consecutive assistant llm.message chunks coalesce into one assistant segment.
 * Consecutive reasoning chunks coalesce into one reasoning segment.
 * tool.call and tool.result are paired by callId (preferred) or FIFO.
 * message.complete does not produce a segment (the assistant text IS the content).
 * message.permission_request produces an event segment.
 */
export function buildSegments(events: UIEvent[]): Segment[] {
  const out: Segment[] = []
  let segIdx = 0

  const nextKey = (): string => `seg-${segIdx++}`

  const pushAssistant = (text: string, ts: number): void => {
    const last = out[out.length - 1]
    if (last && last.kind === 'assistant') last.text += text
    else out.push({ kind: 'assistant', text, key: nextKey(), ts })
  }

  const pushReasoning = (text: string, ts: number): void => {
    const last = out[out.length - 1]
    if (last && last.kind === 'reasoning') last.text += text
    else out.push({ kind: 'reasoning', text, key: nextKey(), ts })
  }

  // Tools awaiting their tool.result. Keyed by callId when available; FIFO fallback.
  const pendingByCallId = new Map<string, Extract<Segment, { kind: 'tool' }>>()
  const pendingFifo: Extract<Segment, { kind: 'tool' }>[] = []

  for (const evt of events) {
    const wire = evt as MessageWireEvent

    if (wire.kind === 'message.created') {
      out.push({ kind: 'user', text: wire.prompt, key: nextKey(), ts: wire.ts })
      continue
    }

    if (wire.kind === 'message.progress') {
      const taskEvt = wire.event as TaskEvent

      if (taskEvt.kind === 'llm.message' && taskEvt.role === 'assistant') {
        pushAssistant(contentToString(taskEvt.content), wire.ts)
      } else if (taskEvt.kind === 'llm.message' && taskEvt.role === 'user') {
        out.push({ kind: 'user', text: contentToString(taskEvt.content), key: nextKey(), ts: wire.ts })
      } else if (taskEvt.kind === 'reasoning') {
        pushReasoning(taskEvt.content, wire.ts)
      } else if (taskEvt.kind === 'tool.call') {
        const seg: Extract<Segment, { kind: 'tool' }> = {
          kind: 'tool',
          tool: taskEvt.tool,
          ok: null,
          input: taskEvt.args ?? {},
          output: null,
          key: nextKey(),
          ts: wire.ts,
        }
        out.push(seg)
        if (taskEvt.callId) pendingByCallId.set(taskEvt.callId, seg)
        else pendingFifo.push(seg)
      } else if (taskEvt.kind === 'tool.result') {
        const byId = taskEvt.callId ? pendingByCallId.get(taskEvt.callId) : undefined
        const target = byId ?? pendingFifo.shift()
        if (byId && taskEvt.callId) pendingByCallId.delete(taskEvt.callId)
        if (target) {
          target.ok = taskEvt.ok
          target.output = toolDetail(taskEvt.payload)
        } else {
          out.push({
            kind: 'event',
            label: taskEvt.ok ? 'tool result' : 'tool error',
            detail: toolDetail(taskEvt.payload),
            key: nextKey(),
            ts: wire.ts,
          })
        }
      } else if (taskEvt.kind === 'error') {
        const label = taskEvt.error.code === 'cancelled' ? 'stopped' : 'error'
        out.push({ kind: 'error', label, detail: taskEvt.error.message ?? 'error', key: nextKey(), ts: wire.ts })
      }
      continue
    }

    if (wire.kind === 'message.permission_request') {
      out.push({
        kind: 'event',
        label: `permission (${wire.risk})`,
        detail: wire.summary,
        key: nextKey(),
        ts: wire.ts,
      })
      continue
    }

    if (wire.kind === 'message.error') {
      const label = wire.error.code === 'cancelled' ? 'stopped' : 'error'
      out.push({ kind: 'error', label, detail: wire.error.message, key: nextKey(), ts: wire.ts })
      continue
    }

    // message.complete, message.dispatched, message.usage, message.plan,
    // message.delegation_plan, message.spawned — no segment (metadata only).
  }

  return out
}

/**
 * Convenience: flatten a MessageRecord's events into render segments.
 * Equivalent to `buildSegments(record.events)`.
 */
export function segmentsForMessage(record: MessageRecord): Segment[] {
  return buildSegments(record.events)
}
