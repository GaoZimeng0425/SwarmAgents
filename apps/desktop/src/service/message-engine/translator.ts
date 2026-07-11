import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { PlanTodo, TaskEvent } from '@swarm/protocol'

import type { MessageEmit } from './emit'

/** Per-attempt outcome collected from pi's event stream. The engine — not the
 *  translator — turns this into the message's SINGLE terminal event. */
export type TranslatorOutcome = {
  /** Assembled assistant text for this attempt (the summary candidate). */
  summary: string
  /** pi delivered a request failure (an assistant message with stopReason 'error'). */
  errorMessage: string | null
  /** pi ended an aborted turn (stopReason 'aborted'): cancel/budget/context/iterations. */
  sawAborted: boolean
}

export type MessageTranslator = {
  handle(e: AgentEvent): void
  outcome(): TranslatorOutcome
  /** Reset per-attempt state before a retry or a new resident-style turn. */
  resetTurn(): void
}

/**
 * Adapts pi AgentEvents to message.* progress emits:
 *   message_update(text_delta)     → message.progress llm.message (buffered; flushed
 *                                    at sentence boundaries or 200 chars)
 *   message_update(thinking_delta) → message.progress reasoning (same buffering)
 *   tool_execution_start/end       → message.progress tool.call / tool.result
 *   update_plan tool result        → message.plan
 *
 * It emits NO terminal and NO usage: pi does not throw on request failure —
 * the failure rides the event stream as stopReason 'error'/'aborted', which is
 * captured into outcome() for the engine's terminal decision.
 */
export function createMessageTranslator(emit: MessageEmit): MessageTranslator {
  let textBuffer = ''
  let thinkingBuffer = ''
  let assembledSummary = ''
  let errorMessage: string | null = null
  let sawAborted = false

  const flushText = (): void => {
    if (!textBuffer) return
    assembledSummary += textBuffer
    const event: TaskEvent = { kind: 'llm.message', role: 'assistant', content: textBuffer, ts: Date.now() }
    emit({ kind: 'message.progress', event })
    textBuffer = ''
  }

  const flushThinking = (): void => {
    if (!thinkingBuffer) return
    const event: TaskEvent = { kind: 'reasoning', content: thinkingBuffer, ts: Date.now() }
    emit({ kind: 'message.progress', event })
    thinkingBuffer = ''
  }

  const captureStop = (m: { stopReason?: string; errorMessage?: string } | undefined): void => {
    if (m?.stopReason === 'error') {
      errorMessage = m.errorMessage ?? 'The model request failed without a message.'
    } else if (m?.stopReason === 'aborted') {
      sawAborted = true
    }
  }

  const handle = (e: AgentEvent): void => {
    if ('message' in e) captureStop((e as { message?: { stopReason?: string; errorMessage?: string } }).message)

    switch (e.type) {
      case 'message_update': {
        const inner = e.assistantMessageEvent
        if (inner && inner.type === 'thinking_delta' && typeof inner.delta === 'string') {
          thinkingBuffer += inner.delta
          if (/[.!?\n]\s*$/.test(thinkingBuffer) || thinkingBuffer.length > 200) flushThinking()
        } else if (inner && inner.type === 'text_delta' && typeof inner.delta === 'string') {
          // Reasoning always precedes the answer; flush it so the panel settles first.
          flushThinking()
          textBuffer += inner.delta
          if (/[.!?\n]\s*$/.test(textBuffer) || textBuffer.length > 200) flushText()
        }
        return
      }
      case 'tool_execution_start': {
        flushThinking()
        flushText()
        const event: TaskEvent = {
          kind: 'tool.call',
          server: 'agent',
          tool: e.toolName ?? 'unknown',
          args: e.args ?? {},
          ts: Date.now(),
          // Correlates start/end so parallel tool results pair with the right call.
          callId: e.toolCallId,
        }
        emit({ kind: 'message.progress', event })
        return
      }
      case 'tool_execution_end': {
        flushText()
        const ok = !e.isError
        const result = e.result as
          | {
              content?: Array<{ type: string; text?: string }>
              details?: { todos?: unknown; screenshotPath?: unknown }
            }
          | undefined
        if (e.toolName === 'update_plan' && Array.isArray(result?.details?.todos)) {
          emit({ kind: 'message.plan', todos: result.details.todos as PlanTodo[] })
        }
        const imagePath =
          typeof result?.details?.screenshotPath === 'string' ? result.details.screenshotPath : undefined
        const payloadText = result?.content?.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('') ?? ''
        const event: TaskEvent = {
          kind: 'tool.result',
          ok,
          payload: { kind: 'text', text: payloadText.slice(0, 4000), ...(imagePath ? { imagePath } : {}) },
          ts: Date.now(),
          callId: e.toolCallId,
        }
        emit({ kind: 'message.progress', event })
        return
      }
      case 'agent_end': {
        flushThinking()
        flushText()
        // agent_end is pi's last event even on a failed/aborted run; its
        // messages re-carry the stop, in case message_end was never seen.
        for (const m of e.messages ?? []) captureStop(m as { stopReason?: string; errorMessage?: string })
        return
      }
      default:
        return
    }
  }

  return {
    handle,
    outcome: () => ({ summary: assembledSummary.trim(), errorMessage, sawAborted }),
    resetTurn: () => {
      textBuffer = ''
      thinkingBuffer = ''
      assembledSummary = ''
      errorMessage = null
      sawAborted = false
    },
  }
}
