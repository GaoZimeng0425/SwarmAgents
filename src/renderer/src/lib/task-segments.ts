import type { Attachment } from '@shared/types/task'
import type { UIEvent } from '@shared/types/ui'

import type { TaskRecord } from './apply-event'

// Every segment carries the timestamp of the event that produced it so the
// renderer can interleave segments across tasks in true causal order (a spawned
// sub-agent's block lands at its spawn point, not appended after the parent).
export type Segment =
  | { kind: 'user'; text: string; attachments: Attachment[]; key: string; taskId: string; ts: number }
  | { kind: 'assistant'; text: string; key: string; taskId: string; ts: number }
  | { kind: 'reasoning'; text: string; key: string; taskId: string; ts: number }
  | {
      kind: 'tool'
      tool: string
      ok: boolean | null
      input: unknown
      output: string | null
      /** Local path to an image the tool produced (e.g. a screenshot), if any. */
      imagePath?: string
      key: string
      taskId: string
      ts: number
    }
  | { kind: 'event'; label: string; detail: string; key: string; taskId: string; ts: number }
  | { kind: 'error'; label: 'error' | 'stopped'; detail: string; key: string; taskId: string; ts: number }

function toolDetail(payload: unknown): string {
  const p = payload as { text?: string } | undefined
  return typeof p?.text === 'string' ? p.text : JSON.stringify(payload ?? {}, null, 2)
}

function toolImagePath(payload: unknown): string | undefined {
  const p = payload as { imagePath?: unknown } | undefined
  return typeof p?.imagePath === 'string' ? p.imagePath : undefined
}

/** Flatten a task's UIEvents into ordered render segments. Pure; unit-tested. */
export function taskSegments(task: TaskRecord): Segment[] {
  const out: Segment[] = [
    {
      kind: 'user',
      text: task.goal,
      attachments: task.attachments ?? [],
      key: `${task.id}-goal`,
      taskId: task.id,
      ts: task.startedAt,
    },
  ]

  // Appended chunks keep the first chunk's ts (the segment's causal position).
  const pushAssistant = (text: string, key: string, ts: number): void => {
    const last = out[out.length - 1]
    if (last && last.kind === 'assistant') last.text += text
    else out.push({ kind: 'assistant', text, key, taskId: task.id, ts })
  }

  const pushReasoning = (text: string, key: string, ts: number): void => {
    const last = out[out.length - 1]
    if (last && last.kind === 'reasoning') last.text += text
    else out.push({ kind: 'reasoning', text, key, taskId: task.id, ts })
  }

  // update_plan is rendered by PlanPanel, so its call AND following result are dropped.
  let skipNextToolResult = false
  // Tools awaiting their tool.result. Keyed by callId when the upstream events
  // carry one: parallel tool execution emits results in completion order, not
  // call order, so a single pending slot mispairs (one card stuck "running", a
  // stray "tool result" row). Calls without a callId fall back to FIFO.
  const pendingByCallId = new Map<string, Extract<Segment, { kind: 'tool' }>>()
  const pendingFifo: Extract<Segment, { kind: 'tool' }>[] = []

  task.events.forEach((e: UIEvent, i) => {
    const key = `${task.id}-${i}`
    if (e.kind === 'task.progress') {
      const ev = e.event
      if (ev.kind === 'llm.message' && ev.role === 'assistant') {
        pushAssistant(typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content), key, e.ts)
      } else if (ev.kind === 'reasoning') {
        pushReasoning(ev.content, key, e.ts)
      } else if (ev.kind === 'tool.call') {
        if (ev.tool === 'update_plan') {
          skipNextToolResult = true
          return
        }
        skipNextToolResult = false
        const seg = {
          kind: 'tool',
          tool: ev.tool,
          ok: null,
          input: ev.args ?? {},
          output: null,
          key,
          taskId: task.id,
          ts: e.ts,
        } as Extract<Segment, { kind: 'tool' }>
        out.push(seg)
        if (ev.callId) pendingByCallId.set(ev.callId, seg)
        else pendingFifo.push(seg)
      } else if (ev.kind === 'tool.result') {
        if (skipNextToolResult) {
          skipNextToolResult = false
          return
        }
        // Prefer an exact callId match (parallel results arrive out of order);
        // otherwise resolve the oldest call without an id (legacy / sequential).
        const byId = ev.callId ? pendingByCallId.get(ev.callId) : undefined
        const target = byId ?? pendingFifo.shift()
        if (byId && ev.callId) pendingByCallId.delete(ev.callId)
        if (target) {
          target.ok = ev.ok
          target.output = toolDetail(ev.payload)
          target.imagePath = toolImagePath(ev.payload)
        } else {
          out.push({
            kind: 'event',
            label: ev.ok ? 'tool result' : 'tool error',
            detail: toolDetail(ev.payload),
            key,
            taskId: task.id,
            ts: e.ts,
          })
        }
      } else if (ev.kind === 'error') {
        const label = ev.error.code === 'cancelled' ? 'stopped' : 'error'
        out.push({ kind: 'error', label, detail: ev.error.message ?? 'error', key, taskId: task.id, ts: e.ts })
      }
    } else if (e.kind === 'task.permission_request') {
      out.push({ kind: 'event', label: `permission (${e.risk})`, detail: e.summary, key, taskId: task.id, ts: e.ts })
    } else if (e.kind === 'task.error') {
      const err = typeof e.error === 'object' && e.error ? (e.error as { message?: unknown; code?: unknown }) : null
      const msg = err && 'message' in err ? String(err.message) : 'error'
      const label = err?.code === 'cancelled' ? 'stopped' : 'error'
      out.push({ kind: 'error', label, detail: msg, key, taskId: task.id, ts: e.ts })
    }
  })

  return out
}
