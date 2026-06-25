import { createLogger } from '@shared/logger'

const log = createLogger({ process: 'service' }).child({ component: 'claude-code' })

// Phase 1 runs each Claude Code session under bypassPermissions so the SDK never
// raises a `canUseTool` request the operator hasn't wired up yet. The approval
// bridge (canUseTool -> cc_approve) lands in Phase 2; until then the operating
// agent steers via cc_send and supervises via cc_observe inside a chosen cwd.
const DEFAULT_PERMISSION_MODE = 'bypassPermissions'
// How long a start/send/interrupt call waits for the session to reach a pause
// (turn finished, session ended, or error) before returning what it has so far
// with status 'running'. Prevents a long Claude turn from blocking the tool call
// indefinitely — the operator can cc_observe / cc_interrupt instead.
const DEFAULT_PAUSE_TIMEOUT_MS = 120_000
// Cap the per-session event buffer so a chatty session can't grow unbounded
// between cc_observe drains.
const MAX_BUFFERED_EVENTS = 1000

export type CCStatus = 'running' | 'idle' | 'completed' | 'failed'

// Normalized, harness-agnostic event surfaced to the operating agent. A narrow
// projection of the SDK's much larger message union — only what cc_observe needs.
export type CCEvent =
  | { kind: 'system'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; tool: string; input?: unknown }
  | { kind: 'result'; text: string; isError: boolean }
  | { kind: 'error'; text: string }

export type CCUsage = { inputTokens: number; outputTokens: number }

export type CCObservation = {
  ccSessionId: string
  status: CCStatus
  /** Events accumulated since the previous drain (cc_observe / the prior call's return). */
  events: CCEvent[]
  /** The Claude Code session UUID, once the SDK has emitted it (resumable later). */
  sdkSessionId?: string
  usage?: CCUsage
  error?: string
}

// --- Narrow SDK slice -------------------------------------------------------
// We type only the fields we read so tests can inject a fake `queryFn` without
// the real CLI, mirroring how mcp/manager narrows the MCP client (McpClientLike).

export type CCUserMessage = {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: string | null
}

type CCContentBlock = {
  type: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
}

// The subset of SDKMessage shapes the consumer loop inspects. Real SDK messages
// are a superset; unknown `type`s fall through to a generic 'other' (ignored).
export type CCRawMessage =
  | { type: 'system'; subtype?: string; session_id?: string }
  | { type: 'assistant'; message?: { content?: CCContentBlock[] }; session_id?: string }
  | {
      type: 'result'
      subtype?: string
      session_id?: string
      is_error?: boolean
      result?: string
      usage?: { input_tokens?: number; output_tokens?: number }
    }
  | { type: string; session_id?: string }

export type CCQuery = AsyncGenerator<CCRawMessage, void> & {
  interrupt(): Promise<void>
}

export type CCQueryOptions = {
  cwd?: string
  model?: string
  permissionMode?: string
  abortController?: AbortController
}

export type CCQueryFn = (input: { prompt: AsyncIterable<CCUserMessage>; options: CCQueryOptions }) => CCQuery

export type ClaudeCodeManager = {
  /** Open a streaming session and run the first prompt; resolves at the first pause. */
  start(input: { ccSessionId: string; cwd?: string; model?: string; prompt: string }): Promise<CCObservation>
  /** Push a follow-up instruction into a live session; resolves at the next pause. */
  send(ccSessionId: string, message: string): Promise<CCObservation>
  /** Snapshot the session and drain buffered events without waiting. */
  observe(ccSessionId: string): CCObservation
  /** Interrupt the current turn; resolves at the resulting pause. */
  interrupt(ccSessionId: string): Promise<CCObservation>
  /** End the session: abort the SDK process and close the input channel. */
  stop(ccSessionId: string): CCObservation
  /** Whether a session id is currently tracked. */
  has(ccSessionId: string): boolean
  /** Kill every live session (service shutdown). */
  dispose(): void
}

// --- Small async primitives -------------------------------------------------

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

type Pushable<T> = {
  push(v: T): void
  end(): void
  [Symbol.asyncIterator](): AsyncIterator<T>
}
// A manually-driven async iterable: the consumer (the SDK) awaits values we push
// from cc_start / cc_send. This is what makes one query span multiple steered turns.
function createPushable<T>(): Pushable<T> {
  const queue: T[] = []
  let pending: ((r: IteratorResult<T>) => void) | null = null
  let ended = false
  return {
    push(v) {
      if (ended) return
      if (pending) {
        const resolve = pending
        pending = null
        resolve({ value: v, done: false })
      } else {
        queue.push(v)
      }
    },
    end() {
      ended = true
      if (pending) {
        const resolve = pending
        pending = null
        resolve({ value: undefined as never, done: true })
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift() as T, done: false })
          if (ended) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise<IteratorResult<T>>((resolve) => {
            pending = resolve
          })
        },
      }
    },
  }
}

// --- Session bookkeeping ----------------------------------------------------

type CCSession = {
  id: string
  input: Pushable<CCUserMessage>
  query: CCQuery
  abort: AbortController
  status: CCStatus
  sdkSessionId?: string
  usage?: CCUsage
  error?: string
  /** Events not yet drained by a return value / cc_observe. */
  buffer: CCEvent[]
  /** Resolved by the consumer loop when the session reaches a pause point. */
  pauseWaiter: Deferred<void> | null
}

function userMessage(text: string): CCUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
}

function normalize(raw: CCRawMessage): CCEvent[] {
  switch (raw.type) {
    case 'system':
      return raw.subtype === 'init' ? [{ kind: 'system', text: 'session initialized' }] : []
    case 'assistant': {
      const blocks = (raw as { message?: { content?: CCContentBlock[] } }).message?.content ?? []
      const out: CCEvent[] = []
      for (const b of blocks) {
        if (b.type === 'text' && b.text) out.push({ kind: 'text', text: b.text })
        else if (b.type === 'thinking' && b.thinking) out.push({ kind: 'thinking', text: b.thinking })
        else if (b.type === 'tool_use' && b.name) out.push({ kind: 'tool_use', tool: b.name, input: b.input })
      }
      return out
    }
    case 'result': {
      const r = raw as Extract<CCRawMessage, { type: 'result' }>
      return [{ kind: 'result', text: r.result ?? '', isError: Boolean(r.is_error) }]
    }
    default:
      return []
  }
}

export function createClaudeCodeManager(deps?: {
  queryFn?: CCQueryFn
  /** Override the start/send/interrupt pause timeout. Test seam; defaults to 120s. */
  pauseTimeoutMs?: number
}): ClaudeCodeManager {
  const sessions = new Map<string, CCSession>()
  const pauseTimeoutMs = deps?.pauseTimeoutMs ?? DEFAULT_PAUSE_TIMEOUT_MS

  // Resolve the query function lazily: tests inject a fake; production loads the
  // real SDK on first start() so the service (and unit tests) never require the
  // `claude` CLI or load the SDK at module init.
  let queryFn = deps?.queryFn
  const resolveQueryFn = async (): Promise<CCQueryFn> => {
    if (!queryFn) {
      const { query } = await import('@anthropic-ai/claude-agent-sdk')
      queryFn = ((input) => query(input as never) as unknown as CCQuery) as CCQueryFn
    }
    return queryFn
  }

  // Wake whoever is awaiting a pause (a start/send/interrupt call). Idempotent:
  // the waiter is cleared on resolve, so extra calls between pauses are no-ops.
  const wake = (s: CCSession): void => {
    if (s.pauseWaiter) {
      const w = s.pauseWaiter
      s.pauseWaiter = null
      w.resolve()
    }
  }

  const drain = (s: CCSession): CCObservation => {
    const events = s.buffer
    s.buffer = []
    return {
      ccSessionId: s.id,
      status: s.status,
      events,
      sdkSessionId: s.sdkSessionId,
      usage: s.usage,
      error: s.error,
    }
  }

  // Wait until the session reaches a pause (turn done / ended / error) or the
  // timeout fires, then drain. On timeout the session is still 'running'.
  const waitForPause = async (s: CCSession, timeoutMs = pauseTimeoutMs): Promise<CCObservation> => {
    if (s.status === 'completed' || s.status === 'failed') return drain(s)
    const w = deferred<void>()
    s.pauseWaiter = w
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null
      wake(s)
    }, timeoutMs)
    timer.unref?.()
    await w.promise
    if (timer) clearTimeout(timer)
    return drain(s)
  }

  const pushEvents = (s: CCSession, events: CCEvent[]): void => {
    for (const e of events) s.buffer.push(e)
    if (s.buffer.length > MAX_BUFFERED_EVENTS) s.buffer.splice(0, s.buffer.length - MAX_BUFFERED_EVENTS)
  }

  // Drive one session's output stream for its whole lifetime. Each `result`
  // ends a turn (status -> idle, can send again); generator end -> completed.
  const consume = async (s: CCSession): Promise<void> => {
    const sessionLog = log.child({ ccSessionId: s.id })
    try {
      for await (const raw of s.query) {
        if (raw.session_id && !s.sdkSessionId) {
          s.sdkSessionId = raw.session_id
          sessionLog.info({ msg: 'sdk session id resolved', sdkSessionId: raw.session_id })
        }
        if (raw.type === 'result') {
          const r = raw as Extract<CCRawMessage, { type: 'result' }>
          if (r.usage) {
            s.usage = { inputTokens: r.usage.input_tokens ?? 0, outputTokens: r.usage.output_tokens ?? 0 }
          }
          pushEvents(s, normalize(raw))
          s.status = 'idle'
          sessionLog.info({ msg: 'turn finished', subtype: r.subtype, isError: Boolean(r.is_error) })
          wake(s)
          continue
        }
        pushEvents(s, normalize(raw))
      }
      s.status = 'completed'
      sessionLog.info({ msg: 'session ended' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      s.status = 'failed'
      s.error = message
      s.buffer.push({ kind: 'error', text: message })
      sessionLog.error({ msg: 'session loop failed', err: message })
    } finally {
      wake(s)
    }
  }

  const get = (ccSessionId: string): CCSession => {
    const s = sessions.get(ccSessionId)
    if (!s) throw new Error(`no Claude Code session: ${ccSessionId}`)
    return s
  }

  return {
    async start({ ccSessionId, cwd, model, prompt }) {
      if (sessions.has(ccSessionId)) throw new Error(`Claude Code session already exists: ${ccSessionId}`)
      const input = createPushable<CCUserMessage>()
      const abort = new AbortController()
      log.info({ msg: 'start', ccSessionId, cwd, model })
      const fn = await resolveQueryFn()
      const query = fn({
        prompt: input,
        options: { cwd, model, permissionMode: DEFAULT_PERMISSION_MODE, abortController: abort },
      })
      const session: CCSession = {
        id: ccSessionId,
        input,
        query,
        abort,
        status: 'running',
        buffer: [],
        pauseWaiter: null,
      }
      sessions.set(ccSessionId, session)
      void consume(session)
      input.push(userMessage(prompt))
      return waitForPause(session)
    },

    async send(ccSessionId, message) {
      const s = get(ccSessionId)
      if (s.status === 'completed' || s.status === 'failed') {
        throw new Error(`Claude Code session ${ccSessionId} is ${s.status}; cannot send`)
      }
      log.info({ msg: 'send', ccSessionId })
      s.status = 'running'
      s.input.push(userMessage(message))
      return waitForPause(s)
    },

    observe(ccSessionId) {
      return drain(get(ccSessionId))
    },

    async interrupt(ccSessionId) {
      const s = get(ccSessionId)
      log.info({ msg: 'interrupt', ccSessionId })
      try {
        await s.query.interrupt()
      } catch (err) {
        log.warn({ msg: 'interrupt failed', ccSessionId, err: err instanceof Error ? err.message : String(err) })
      }
      return waitForPause(s)
    },

    stop(ccSessionId) {
      const s = get(ccSessionId)
      log.info({ msg: 'stop', ccSessionId })
      s.abort.abort()
      s.input.end()
      const snapshot = drain(s)
      sessions.delete(ccSessionId)
      return { ...snapshot, status: 'completed' }
    },

    has: (ccSessionId) => sessions.has(ccSessionId),

    dispose() {
      for (const s of sessions.values()) {
        s.abort.abort()
        s.input.end()
      }
      sessions.clear()
      log.info({ msg: 'disposed' })
    },
  }
}
