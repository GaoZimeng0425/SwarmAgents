import type { Attachment } from '@shared/types/task'
import type { UIEvent } from '@shared/types/ui'

import type { TaskRecord } from './apply-event'

export type Segment =
  | { kind: 'user'; text: string; attachments: Attachment[]; key: string; taskId: string }
  | { kind: 'assistant'; text: string; key: string; taskId: string }
  | { kind: 'reasoning'; text: string; key: string; taskId: string }
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
    }
  | { kind: 'event'; label: string; detail: string; key: string; taskId: string }
  | { kind: 'error'; label: 'error' | 'stopped'; detail: string; key: string; taskId: string }

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
    { kind: 'user', text: task.goal, attachments: task.attachments ?? [], key: `${task.id}-goal`, taskId: task.id },
  ]

  const pushAssistant = (text: string, key: string): void => {
    const last = out[out.length - 1]
    if (last && last.kind === 'assistant') last.text += text
    else out.push({ kind: 'assistant', text, key, taskId: task.id })
  }

  const pushReasoning = (text: string, key: string): void => {
    const last = out[out.length - 1]
    if (last && last.kind === 'reasoning') last.text += text
    else out.push({ kind: 'reasoning', text, key, taskId: task.id })
  }

  // update_plan is rendered by PlanPanel, so its call AND following result are dropped.
  let skipNextToolResult = false
  // The tool.call awaiting its tool.result, so the pair merges into one segment.
  let pendingTool: Extract<Segment, { kind: 'tool' }> | null = null

  task.events.forEach((e: UIEvent, i) => {
    const key = `${task.id}-${i}`
    if (e.kind === 'task.progress') {
      const ev = e.event
      if (ev.kind === 'llm.message' && ev.role === 'assistant') {
        pushAssistant(typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content), key)
      } else if (ev.kind === 'reasoning') {
        pushReasoning(ev.content, key)
      } else if (ev.kind === 'tool.call') {
        // A new call supersedes any unresolved prior call: drop a stale skip flag
        // and stop pairing a previous call (it stays in `out`, shown as running).
        skipNextToolResult = false
        pendingTool = null
        if (ev.tool === 'update_plan') {
          skipNextToolResult = true
          return
        }
        pendingTool = {
          kind: 'tool',
          tool: ev.tool,
          ok: null,
          input: ev.args ?? {},
          output: null,
          key,
          taskId: task.id,
        }
        out.push(pendingTool)
      } else if (ev.kind === 'tool.result') {
        if (skipNextToolResult) {
          skipNextToolResult = false
          return
        }
        if (pendingTool) {
          pendingTool.ok = ev.ok
          pendingTool.output = toolDetail(ev.payload)
          pendingTool.imagePath = toolImagePath(ev.payload)
          pendingTool = null
        } else {
          out.push({
            kind: 'event',
            label: ev.ok ? 'tool result' : 'tool error',
            detail: toolDetail(ev.payload),
            key,
            taskId: task.id,
          })
        }
      } else if (ev.kind === 'error') {
        out.push({ kind: 'event', label: 'error', detail: ev.error.message ?? 'error', key, taskId: task.id })
      }
    } else if (e.kind === 'task.permission_request') {
      out.push({ kind: 'event', label: `permission (${e.risk})`, detail: e.summary, key, taskId: task.id })
    } else if (e.kind === 'task.error') {
      const err = typeof e.error === 'object' && e.error ? (e.error as { message?: unknown; code?: unknown }) : null
      const msg = err && 'message' in err ? String(err.message) : 'error'
      const label = err?.code === 'cancelled' ? 'stopped' : 'error'
      out.push({ kind: 'error', label, detail: msg, key, taskId: task.id })
    }
  })

  return out
}
