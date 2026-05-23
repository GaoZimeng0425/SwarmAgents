import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { Outbound } from '@shared/types/ipc'
import type { TaskEvent } from '@shared/types/task'

type EmitFn = (out: Outbound) => void

/**
 * Translate one pi AgentEvent into zero or more SwarmAgents Outbound messages.
 *
 * pi event → Outbound mapping:
 *   message_update(text_delta) → progress(llm.message) (buffered, flushed at sentence boundaries or 200 chars)
 *   tool_execution_start       → progress(tool.call)
 *   tool_execution_end         → progress(tool.result)
 *   agent_end                  → task.complete (with concatenated assistant text)
 *
 * Lifecycle events (agent_start, turn_start, turn_end, message_start, message_end)
 * are intentionally dropped — internal to the loop, no extra UI value beyond
 * tool.call/tool.result + llm.message.
 */
export function createEventTranslator(
  taskId: string,
  emit: EmitFn,
): {
  handle: (e: AgentEvent) => void
  getFinalSummary: () => string
} {
  let textBuffer = ''
  let assembledSummary = ''

  const flushText = (): void => {
    if (!textBuffer) return
    assembledSummary += textBuffer
    const event: TaskEvent = {
      kind: 'llm.message',
      role: 'assistant',
      content: textBuffer,
      ts: Date.now(),
    }
    emit({ type: 'progress', event })
    textBuffer = ''
  }

  const handle = (e: AgentEvent): void => {
    switch (e.type) {
      case 'message_update': {
        const inner = e.assistantMessageEvent
        if (inner && inner.type === 'text_delta' && typeof inner.delta === 'string') {
          textBuffer += inner.delta
          if (/[.!?\n]\s*$/.test(textBuffer) || textBuffer.length > 200) flushText()
        }
        return
      }
      case 'tool_execution_start': {
        flushText()
        const event: TaskEvent = {
          kind: 'tool.call',
          server: 'agent',
          tool: e.toolName ?? 'unknown',
          args: e.args ?? {},
          ts: Date.now(),
        }
        emit({ type: 'progress', event })
        return
      }
      case 'tool_execution_end': {
        flushText()
        const ok = !e.isError
        const result = e.result as { content?: Array<{ type: string; text?: string }> } | undefined
        const payloadText =
          result?.content?.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('') ?? ''
        const event: TaskEvent = {
          kind: 'tool.result',
          ok,
          payload: { kind: 'text', text: payloadText.slice(0, 4000) },
          ts: Date.now(),
        }
        emit({ type: 'progress', event })
        return
      }
      case 'agent_end': {
        flushText()
        const summary = assembledSummary.trim() || `Completed task ${taskId}.`
        emit({
          type: 'task.complete',
          taskId,
          result: { summary, artifacts: [] },
        })
        return
      }
      default:
        return
    }
  }

  const getFinalSummary = (): string => assembledSummary

  return { handle, getFinalSummary }
}
