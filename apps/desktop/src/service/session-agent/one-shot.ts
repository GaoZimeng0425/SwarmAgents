import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  convertToLlm,
  type StreamFn,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core'
import type { Api, ImageContent, Model } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'
import type { Attachment } from '@swarm/protocol'

const log = createLogger({ process: 'service' }).child({ component: 'one-shot' })

/**
 * A single, non-persisted pi Agent invocation (spec §3.6): the analysis flows'
 * card runs and the analyze_image vision sub-run. Unlike SessionAgent it writes
 * NOTHING to session_entries — these are not conversations — and streams pi
 * AgentEvents to the caller via `onEvent` so each flow can translate them into
 * its own domain events. It acquires a slot from the injected pool (top-level
 * analysis runs) or a no-op one (a nested vision run that rides its parent's
 * slot), and is abortable via `ports.signal`.
 */
export type OneShotSpec = {
  /** Correlation id for logs only. */
  label: string
  systemPrompt: string
  model: Model<Api>
  apiKey?: string
  thinkingLevel: ThinkingLevel
  tools: AgentTool[]
  maxTurns: number
  prompt: string
  attachments?: Attachment[]
  /** Fires for every pi AgentEvent so callers can translate streaming output. */
  onEvent?: (e: AgentEvent) => void
  /** Tests inject a fake here to drive the loop without a provider. */
  streamFn?: StreamFn
}

export type OneShotPorts = {
  /** Global concurrency pool (or a no-op for a nested run that rides its parent's slot). */
  acquireSlot: (signal: AbortSignal) => Promise<() => void>
  /** External cancellation (e.g. the vision sub-run rides the parent run's signal). */
  signal?: AbortSignal
}

export type OneShotResult = { status: 'completed' | 'failed' | 'cancelled'; summary: string }

export type OneShotRunner = (spec: OneShotSpec, ports: OneShotPorts) => Promise<OneShotResult>

function isAssistant(message: unknown): message is { role: 'assistant'; stopReason?: string } {
  return typeof message === 'object' && message !== null && (message as { role?: string }).role === 'assistant'
}

/** Concatenate an AgentMessage's text content (string, or text parts of an array). */
export function assistantText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: 'text'; text?: string } => (c as { type?: string })?.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
  }
  return ''
}

export const runOneShot: OneShotRunner = async (spec, ports) => {
  const runLog = log.child({ label: spec.label })
  const ac = new AbortController()
  if (ports.signal) {
    if (ports.signal.aborted) ac.abort()
    else ports.signal.addEventListener('abort', () => ac.abort(), { once: true })
  }

  const release = await ports.acquireSlot(ac.signal)
  if (ac.signal.aborted) {
    release()
    runLog.info({ msg: 'one-shot cancelled before dispatch' })
    return { status: 'cancelled', summary: '' }
  }

  let turns = 0
  const agent = new Agent({
    initialState: {
      systemPrompt: spec.systemPrompt,
      model: spec.model,
      thinkingLevel: spec.thinkingLevel,
      tools: spec.tools,
      messages: [],
    },
    convertToLlm,
    ...(spec.streamFn ? { streamFn: spec.streamFn } : {}),
    getApiKey: () => spec.apiKey,
    // Backstop for reasoning-only loops (mirrors SessionAgent / the old engine).
    prepareNextTurn: () => {
      turns += 1
      if (turns >= spec.maxTurns) {
        runLog.warn({ msg: 'one-shot max iterations reached, aborting', turns })
        agent.abort()
      }
      return undefined
    },
  })
  if (spec.onEvent) agent.subscribe(spec.onEvent)
  if (ac.signal.aborted) agent.abort()
  else ac.signal.addEventListener('abort', () => agent.abort(), { once: true })

  const t0 = Date.now()
  runLog.info({ msg: 'one-shot started', promptLen: spec.prompt.length, modelId: spec.model.id })
  try {
    const images: ImageContent[] = (spec.attachments ?? []).map((a) => ({
      type: 'image',
      data: a.data,
      mimeType: a.mimeType,
    }))
    await agent.prompt(spec.prompt, images.length > 0 ? images : undefined)
    const messages = agent.state.messages
    let last: { role: 'assistant'; stopReason?: string } | undefined
    let summary = ''
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isAssistant(messages[i])) {
        last = messages[i] as { role: 'assistant'; stopReason?: string }
        summary = assistantText(messages[i])
        break
      }
    }
    const status: OneShotResult['status'] = ac.signal.aborted
      ? 'cancelled'
      : last?.stopReason === 'error'
        ? 'failed'
        : last?.stopReason === 'aborted'
          ? 'cancelled'
          : 'completed'
    runLog.info({ msg: 'one-shot finished', status, durationMs: Date.now() - t0 })
    return { status, summary }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    runLog.error({ msg: 'one-shot crashed', err: message })
    return { status: ac.signal.aborted ? 'cancelled' : 'failed', summary: message }
  } finally {
    release()
  }
}
