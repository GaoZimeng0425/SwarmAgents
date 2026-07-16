import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  convertToLlm,
  type StreamFn,
  type ThinkingLevel,
  uuidv7,
} from '@earendil-works/pi-agent-core'
import type { Api, ImageContent, Model, Usage } from '@earendil-works/pi-ai'
import type {
  AgentWireEvent,
  Attachment,
  ConsumedResources,
  MessageEntry,
  RunStatus,
  SessionEntry,
} from '@swarm/protocol'
import { emptyUsed } from '@swarm/protocol'
import type { Logger } from 'pino'

// Type-only: pulls resolveModel's real return shape into SessionAgentDeps
// without importing message-engine/engine.ts (which drags the whole old
// engine — deleted in Task 9). resolveModel/composeSystemPrompt/
// clampThinkingLevel are NOT called from this file: cfg.systemPrompt and
// cfg.thinkingLevel arrive already composed/clamped from SessionService
// (Task 5), which owns calling those helpers before invoking
// buildAgentConfig(). See task-3-report.md for the full rationale.
import type { resolveModel } from '../message-engine/models'
import { hasUnansweredUserTail, messagesFromEntries } from './context'
import type { EntryStore } from './sqlite-storage'

const UPDATE_COALESCE_MS = 40

export type SessionAgentDeps = {
  sessionId: string
  entries: EntryStore
  broadcast: (e: AgentWireEvent) => void
  acquireSlot: (signal: AbortSignal) => Promise<() => void>
  buildAgentConfig: () => {
    systemPrompt: string
    model: ReturnType<typeof resolveModel>
    // resolveModel (message-engine/models.ts) returns a bare pi Model<Api> —
    // no embedded credential (see engine.ts:78-83, where the API key comes
    // from `deps.provider.apiKey`, a sibling of the model, not a field on it).
    // Carried here as its own field so getApiKey() has something to read.
    apiKey?: string
    thinkingLevel: ThinkingLevel
    tools: AgentTool[] // Task 4 supplies real tools; [] until then
    maxTurns: number
    streamFn?: StreamFn // tests inject a fake here
  }
  hooks?: {
    // Task 4 fills this in; the wrapper below always counts the call attempt
    // (ported semantics of engine.ts's `used.calls += 1` in beforeToolCall)
    // regardless of whether a real hook is wired yet.
    beforeToolCall?: Agent['beforeToolCall']
  }
  log: Logger
}

export type RunResult = { runId: string; status: RunStatus; summary: string }

function toImageContent(a: Attachment): ImageContent {
  return { type: 'image', data: a.data, mimeType: a.mimeType }
}

/**
 * SessionAgent: the entries-driven pi Agent run loop (spec §3.3). One instance
 * per session. `submitUserMessage` persists the prompt immediately; the loop
 * (re)builds `agent.state.messages` from the entry log and calls
 * `agent.continue()`, translating every pi AgentEvent to its wire twin.
 */
export class SessionAgent {
  private agent: Agent | null = null
  private _phase: 'idle' | 'turn' = 'idle'
  private runId = ''
  private slotAbort: AbortController | null = null
  private appended = new WeakSet<object>()
  private pendingUpdate: AgentWireEvent | null = null
  private updateTimer: ReturnType<typeof setTimeout> | null = null
  // Waiter queue (not a single latent promise): settle() can otherwise race a
  // caller who invokes waitForCompletion() *after* the run has already
  // finished, silently dropping the result. lastResult + the idle check let a
  // late caller observe the outcome instead of hanging forever.
  private pendingWaiters: Array<(r: RunResult) => void> = []
  private lastResult: RunResult | null = null
  private turns = 0
  private maxTurns = 25
  private forcedStatus: RunStatus | null = null
  // Per-run usage accumulators (reset in runOnce; ported semantics from
  // message-engine/engine.ts:104-121,256-268, deleted in Task 9).
  private turnUsed: ConsumedResources = emptyUsed()
  private turnCalls = 0
  private contextTokens = 0
  private runStartedAt = 0
  private currentModel: Model<Api> | undefined
  private currentApiKey: string | undefined

  constructor(private readonly deps: SessionAgentDeps) {}

  get phase() {
    return this._phase
  }

  submitUserMessage(text: string, attachments: Attachment[] = []): { entryRowId: number } {
    // ISO string per binding decision #7 (ts is opaque JSON on the wire —
    // session-entry.ts's MessagePayload doesn't constrain it); pi's own
    // UserMessage.timestamp is a number, hence the double cast below.
    const message: AgentMessage = {
      role: 'user',
      content: attachments.length ? [{ type: 'text', text }, ...attachments.map(toImageContent)] : text,
      timestamp: new Date().toISOString(),
    } as unknown as AgentMessage
    const rowId = this.appendMessageEntry(message)
    this.deps.log.info({ msg: 'user message submitted', sessionId: this.deps.sessionId, entryRowId: rowId })
    // If busy, do nothing further: the running loop's next hasUnansweredUserTail
    // check (after the current run settles) picks this entry up as a fresh run.
    if (this._phase === 'idle') void this.runLoop()
    return { entryRowId: rowId }
  }

  /** Resolves when the session goes idle with no unanswered user entries left. */
  waitForCompletion(): Promise<RunResult> {
    if (this._phase === 'idle' && this.lastResult) return Promise.resolve(this.lastResult)
    return new Promise((resolve) => this.pendingWaiters.push(resolve))
  }

  cancel(): void {
    this.slotAbort?.abort()
    this.agent?.abort()
  }

  dispose(): void {
    this.cancel()
    if (this.updateTimer) clearTimeout(this.updateTimer)
    this.updateTimer = null
    this.pendingUpdate = null
    this.agent = null
  }

  /** Appends (persist) then broadcasts entry_appended — the ONE write path. SessionAgent only ever appends 'message' entries. */
  private appendMessageEntry(message: AgentMessage): number {
    const rows = this.deps.entries.list(this.deps.sessionId)
    const entry: SessionEntry = {
      type: 'message',
      id: uuidv7(),
      parentId: rows.length ? rows[rows.length - 1].entry.id : null,
      timestamp: new Date().toISOString(),
      // pi's AgentMessage vs. the wire schema's loose MessagePayload
      // (`{ role: string, ... }`, validated in sqlite-storage.ts's append()).
      // Safe here because we only ever construct 'message' entries; double
      // cast since the two types don't structurally overlap (see context.ts).
      message: message as unknown as MessageEntry['message'],
    }
    const rowId = this.deps.entries.append(this.deps.sessionId, entry)
    this.deps.broadcast({ kind: 'entry_appended', sessionId: this.deps.sessionId, rowId, entry })
    return rowId
  }

  private appendMessageOnce(message: AgentMessage): void {
    if (typeof message !== 'object' || message === null) return
    if (this.appended.has(message)) return
    this.appended.add(message)
    this.appendMessageEntry(message)
  }

  private buildAgent(cfg: ReturnType<SessionAgentDeps['buildAgentConfig']>): Agent {
    const agent = new Agent({
      initialState: {
        systemPrompt: cfg.systemPrompt,
        model: cfg.model,
        thinkingLevel: cfg.thinkingLevel,
        tools: cfg.tools,
        messages: [],
      },
      convertToLlm,
      ...(cfg.streamFn ? { streamFn: cfg.streamFn } : {}),
      getApiKey: () => this.currentApiKey,
      beforeToolCall: async (ctx, signal) => {
        this.turnCalls += 1
        return (await this.deps.hooks?.beforeToolCall?.(ctx, signal)) ?? undefined
      },
      prepareNextTurn: () => {
        this.turns += 1
        if (this.turns >= this.maxTurns) {
          this.forcedStatus = 'cancelled'
          this.deps.log.warn({
            msg: 'max iterations reached, aborting',
            sessionId: this.deps.sessionId,
            runId: this.runId,
            turns: this.turns,
          })
          agent.abort()
        }
        return undefined
      },
    })
    agent.subscribe((e) => this.handleAgentEvent(e))
    return agent
  }

  private handleAgentEvent(e: AgentEvent): void {
    const scope = { sessionId: this.deps.sessionId, runId: this.runId }
    switch (e.type) {
      case 'message_update': {
        this.pendingUpdate = { kind: 'message_update', ...scope, message: e.message }
        this.updateTimer ??= setTimeout(() => {
          this.updateTimer = null
          if (this.pendingUpdate) this.deps.broadcast(this.pendingUpdate)
          this.pendingUpdate = null
        }, UPDATE_COALESCE_MS)
        return
      }
      case 'message_start':
        this.deps.broadcast({ kind: 'message_start', ...scope, message: e.message })
        return
      case 'message_end':
        this.flushUpdate()
        this.appendMessageOnce(e.message)
        this.deps.broadcast({ kind: 'message_end', ...scope, message: e.message })
        return
      case 'turn_start':
        this.deps.broadcast({ kind: 'turn_start', ...scope })
        return
      case 'turn_end': {
        for (const tr of e.toolResults) this.appendMessageOnce(tr)
        this.deps.broadcast({ kind: 'turn_end', ...scope, ...this.usageSnapshot(e.message) })
        return
      }
      case 'tool_execution_start':
        this.deps.broadcast({
          kind: 'tool_execution_start',
          ...scope,
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          args: e.args,
        })
        return
      case 'tool_execution_update':
        this.deps.broadcast({
          kind: 'tool_execution_update',
          ...scope,
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          partialResult: e.partialResult,
        })
        return
      case 'tool_execution_end':
        this.deps.broadcast({
          kind: 'tool_execution_end',
          ...scope,
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          result: e.result,
          isError: e.isError,
        })
        return
      case 'agent_end':
        this.flushUpdate()
        // Straggler net (invariant #4): pi's event emission points for
        // toolResult messages are an implementation detail; the WeakSet dedup
        // in appendMessageOnce makes "exactly once" hold regardless.
        for (const m of e.messages) this.appendMessageOnce(m)
        return
      default:
        return
    }
  }

  private async runLoop(): Promise<void> {
    this._phase = 'turn'
    try {
      while (hasUnansweredUserTail(this.deps.entries.list(this.deps.sessionId))) {
        const result = await this.runOnce()
        // Discard check MUST run before the early return below — a failed
        // run's discardAgent flag would otherwise never be observed (dead
        // code in a status!=='completed'-then-return ordering).
        if (result.discardAgent) this.agent = null
        if (result.status !== 'completed') {
          this.settle(result)
          return
        }
      }
      this.settle({ runId: this.runId, status: 'completed', summary: this.lastAssistantText() })
    } finally {
      this._phase = 'idle'
    }
  }

  private async runOnce(): Promise<RunResult & { discardAgent?: boolean }> {
    this.runId = uuidv7()
    this.turns = 0
    this.turnCalls = 0
    this.turnUsed = emptyUsed()
    this.contextTokens = 0
    this.runStartedAt = Date.now()
    this.forcedStatus = null
    const cfg = this.deps.buildAgentConfig()
    this.maxTurns = cfg.maxTurns
    this.currentModel = cfg.model
    this.currentApiKey = cfg.apiKey
    this.deps.broadcast({ kind: 'agent_start', sessionId: this.deps.sessionId, runId: this.runId })
    this.deps.log.info({ msg: 'run started', sessionId: this.deps.sessionId, runId: this.runId })

    this.slotAbort = new AbortController()
    let release: (() => void) | null = null
    try {
      release = await this.deps.acquireSlot(this.slotAbort.signal)
    } catch {
      return this.finishRun('cancelled', 'Stopped by user.')
    }
    try {
      this.agent ??= this.buildAgent(cfg)
      // Reused agents must pick up this run's fresh cfg — buildAgentConfig()
      // is "resolved fresh per run" precisely so model/prompt/thinking-level
      // changes between runs take effect (e.g. mid-session model switch).
      this.agent.state.model = cfg.model
      this.agent.state.thinkingLevel = cfg.thinkingLevel
      this.agent.state.systemPrompt = cfg.systemPrompt
      this.agent.state.tools = cfg.tools
      this.agent.state.messages = messagesFromEntries(this.deps.entries.list(this.deps.sessionId))
      await this.agent.continue()
      const last = this.lastAssistant()
      if (this.forcedStatus) return this.finishRun(this.forcedStatus, last?.errorMessage ?? 'max iterations reached')
      if (last?.stopReason === 'error')
        return { ...this.finishRun('failed', last.errorMessage ?? 'request failed'), discardAgent: true }
      if (last?.stopReason === 'aborted') return this.finishRun('cancelled', 'Stopped by user.')
      return this.finishRun('completed', this.lastAssistantText())
    } catch (err) {
      this.deps.log.error({
        msg: 'run crashed',
        sessionId: this.deps.sessionId,
        runId: this.runId,
        err: err instanceof Error ? err.message : String(err),
      })
      return { ...this.finishRun('failed', String(err)), discardAgent: true }
    } finally {
      release?.()
      this.slotAbort = null
    }
  }

  private finishRun(status: RunStatus, summary: string): RunResult {
    this.deps.broadcast({
      kind: 'agent_end',
      sessionId: this.deps.sessionId,
      runId: this.runId,
      status,
      ...(status !== 'completed' ? { errorMessage: summary } : {}),
    })
    this.deps.log.info({ msg: 'run finished', sessionId: this.deps.sessionId, runId: this.runId, status })
    return { runId: this.runId, status, summary }
  }

  private settle(result: RunResult): void {
    this.lastResult = result
    const waiters = this.pendingWaiters
    this.pendingWaiters = []
    for (const w of waiters) w(result)
  }

  private flushUpdate(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer)
      this.updateTimer = null
    }
    if (this.pendingUpdate) {
      this.deps.broadcast(this.pendingUpdate)
      this.pendingUpdate = null
    }
  }

  // Ported from message-engine/engine.ts:256-268 (deleted in Task 9): tokens/
  // cache are latest-turn snapshots (each turn re-sends the whole
  // conversation), usdCents accumulates across turns, contextTokens is the
  // current occupancy snapshot.
  private usageSnapshot(message: AgentMessage): {
    used: ConsumedResources
    contextTokens?: number
    contextWindow?: number
    model?: string
  } {
    const usage = (message as { usage?: Usage }).usage
    if (usage) {
      this.turnUsed = {
        ...this.turnUsed,
        tokens: usage.totalTokens,
        usdCents: this.turnUsed.usdCents + Math.round(usage.cost.total * 100),
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
      }
      this.contextTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output
    }
    return {
      used: { ...this.turnUsed, calls: this.turnCalls, wallMs: Date.now() - this.runStartedAt },
      contextTokens: usage ? this.contextTokens : undefined,
      contextWindow: this.currentModel?.contextWindow,
      model: this.currentModel?.id,
    }
  }

  private lastAssistant(): { role: 'assistant'; stopReason?: string; errorMessage?: string } | undefined {
    const messages = this.agent?.state.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { role?: string }
      if (m.role === 'assistant') return m as { role: 'assistant'; stopReason?: string; errorMessage?: string }
    }
    return undefined
  }

  private lastAssistantText(): string {
    const m = this.lastAssistant() as { content?: Array<{ type: string; text?: string }> } | undefined
    if (!m?.content) return ''
    return m.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
  }
}
