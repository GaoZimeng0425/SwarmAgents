import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createLogger } from '@shared/logger'
import type {
  AgentDefinition,
  Artifact,
  Attachment,
  DelegateResult,
  DelegationItem,
  DelegationItemStatus,
  PermissionDecision,
  PermissionMode,
  ProviderInjection,
  RunOptions,
  UIEvent,
} from '@swarm/protocol'
import { allowlistForAgent, type BudgetConfig, defaultBudgetConfig } from '@swarm/protocol'
import {
  applyAgentModel,
  applyDelegationPlan,
  applyDelegationUpdate,
  DEFAULT_AGENT_DEF,
  type PlanItemState,
  replayDelegationEvents,
  SYSTEM_SESSION_ID,
} from '@swarm/shared'
import { ulid } from 'ulid'

import { withAgentTypes } from '../agents/prompt'
import type { AgentStore } from '../agents/store'
import { buildMarkdown } from '../conversation/markdown-export'
import type { ConversationStore } from '../conversation/store'
import { createAgentDirectory } from '../directory/receptionist'
import type { Broadcaster } from '../ipc/broadcaster'
import { createMessageEmit, type MessageEmitPorts } from '../message-engine/emit'
import { type LaunchPorts, launchMessage, type MessageSpec } from '../message-engine/launch'
import { withSkills } from '../skills/prompt'
import type { SkillStore } from '../skills/store'
import { registerBuiltinTools } from '../tools/builtins'
import { createToolRegistry, type ToolRegistry } from '../tools/registry'
import { createPermissionRegistry, type PermissionRegistry } from './permission-registry'
import { createSeqCounter } from './seq-counter'
import { createTerminalRegistry, type TerminalRegistry } from './terminal-registry'

const log = createLogger({ process: 'service' }).child({ component: 'session-service' })

// Plan mode is read-only: it grants inspection tools but no shell, no fs writes,
// and no peekaboo interactions, so the agent physically cannot mutate anything
// while it produces a plan. Applies to the composer's main task only.
const PLAN_READONLY_ALLOWLIST = [
  'fs.read_file',
  'fs.list_dir',
  'fs.glob',
  'fs.grep',
  'web.fetch',
  'web.search',
  'peekaboo.see_screen',
  'peekaboo.list_apps',
  // update_plan only — exclude delegate, whose child could mutate.
  'agent.update_plan',
]

type SessionState = {
  id: string
  provider: ProviderInjection
  permissionRegistry: PermissionRegistry
  messages: AgentMessage[]
  /** Set when this session was created by forkToNewSession — links back to the
   *  source session + the message id at the fork point. Optional metadata only. */
  forkedFrom?: { sessionId: string; messageId: string }
}

type SessionServiceConfig = {
  store: ConversationStore
  broadcaster: Broadcaster
  maxConcurrent: number
  getProvider(key: string): ProviderInjection | undefined
  toolRegistry?: ToolRegistry
  skillStore?: SkillStore
  agentStore?: AgentStore
  /** Returns the user-configured per-task budgets; defaults apply when omitted. */
  getBudgetConfig?: () => BudgetConfig
  /** Live predicate from the tool-toggles store; disabled skills are dropped from the catalog. */
  isSkillEnabled?: (name: string) => boolean
  /** Directory where session-markdown exports are written. Required for exportSessionMarkdown. */
  exportsDir?: string
  /**
   * Optional Claude-Code-style hooks sink. Invoked once per emitted run.*
   * event with (eventName, evt); the dispatcher maps run.* kinds to the
   * configured Claude event names (Notification/PermissionRequest/Stop/…).
   * Fire-and-forget — a throwing/slow sink must never block emit.
   */
  dispatchHook?: (eventName: string, payload: unknown) => void
}

export type SessionService = {
  createSession(provider: ProviderInjection): { sessionId: string }
  ensureSystemSession(fromSessionId: string): string
  submitPrompt(
    sessionId: string,
    prompt: string,
    attachments?: Attachment[],
    onComplete?: (status: 'completed' | 'failed' | 'cancelled', error?: string) => void,
    options?: RunOptions
  ): { messageId: string }
  runWork(
    sessionId: string,
    prompt: string,
    options?: RunOptions
  ): Promise<{ messageId: string; status: string; summary: string }>
  /**
   * Fork a session at a checkpoint: create a new session sharing the source's
   * provider, reconstruct the transcript up to (and including) forkPointMessageId
   * as prior context, and launch a work run with `newPrompt` on top of it.
   * Returns the new session id and the fork's first message id (the latter is
   * filled synchronously where possible, otherwise an empty string until the
   * launched run mints one).
   */
  forkToNewSession(
    sourceSessionId: string,
    forkPointMessageId: string,
    newPrompt: string,
    opts?: { agentType?: string }
  ): { sessionId: string; messageId: string }
  resolvePermission(sessionId: string, actionId: string, decision: PermissionDecision): void
  cancelMessage(sessionId: string, messageId: string): void
  promoteQueuedMessage(sessionId: string, messageId: string): void
  deleteSession(sessionId: string): void
  renameSession(sessionId: string, title: string): void
  setSessionPinned(sessionId: string, pinned: boolean): void
  updateSessionSettings(sessionId: string, settings: import('@swarm/protocol').SessionSettings): void
  reorderSessions(orderedIds: string[]): void
  listSessions(): import('@swarm/protocol').SessionSummary[]
  getMessageEvents(sessionId: string): import('@swarm/protocol').MessageEvent[]
  /** Build a markdown transcript of the session and write it to exportsDir; returns the file path. */
  exportSessionMarkdown(sessionId: string): Promise<{ path: string }>
  getUsageStats(rangeDays: number): import('@swarm/protocol').UsageStats
  /** In-memory terminal-status registry (query directly: isTerminal/getStatus). */
  terminalRegistry: TerminalRegistry
  /**
   * Startup pass for interrupted-on-restart recovery: for every session marked
   * interrupted by the store's restart cleanup, find runs that were dispatched
   * but never reached a terminal event, append a synthetic run.error to
   * run_events (so replay reaches terminal instead of stuck-running), and mark
   * each terminal in the registry. Reads BOTH the legacy task.* and the new
   * run.* vocabularies, so it stays correct across the W4 migration switchover.
   */
  markInterruptedRunsTerminal(): void
}

// session-service owns sensible defaults for the agent-execution subsystem. In
// production index.ts injects a shared registry; this default keeps the service
// usable for tests/scripts that omit it.
function buildDefaultRegistry(): ToolRegistry {
  const r = createToolRegistry()
  registerBuiltinTools(r)
  return r
}

/**
 * Reconstruct an `AgentMessage[]` transcript from a session's persisted message
 * events, suitable for seeding a forked session's `history` (prior context).
 *
 * Minimal-fidelity by design — only the LLM-visible conversational turns are
 * rebuilt; tool.call/tool.result wiring (which would need full `ToolCall` /
 * `ToolResultMessage` reconstruction with stable callIds) is intentionally
 * omitted. The resulting context is enough for a forked run to continue a
 * conversation; it is NOT a byte-perfect replay of the source agent state.
 *
 * Mapping:
 *   message.created (prompt)            → UserMessage(prompt)
 *   message.progress llm.message(user)  → UserMessage(content)
 *   message.progress llm.message(assistant) → AssistantMessage (consecutive
 *                                             chunks coalesce into one bubble,
 *                                             like task-segments.ts does)
 *   everything else (reasoning, tool.*,
 *   permissions, terminals, metadata)   → skipped
 *
 * `provider` supplies the `api`/`provider`/`model` fields the AssistantMessage
 * shape requires; usage is zeroed and stopReason is 'stop' since these are
 * synthesized, not round-tripped from a real model response.
 */
function reconstructHistoryFromEvents(
  rows: Array<{ messageId: string; event: UIEvent }>,
  provider: ProviderInjection
): AgentMessage[] {
  // pi-ai's `Api` is a union of KnownApi | string, so the wire-style→api-id
  // mapping produces a valid Api without importing the type directly.
  const api = provider.apiStyle === 'anthropic' ? 'anthropic-messages' : 'openai-completions'
  const out: AgentMessage[] = []
  // Pending assistant text accumulates across consecutive llm.message(assistant)
  // chunks until a non-assistant event flushes it (mirrors task-segments.ts).
  let pendingAssistantText = ''
  let pendingAssistantTs: number | null = null
  const flushAssistant = (): void => {
    if (!pendingAssistantText) {
      pendingAssistantTs = null
      return
    }
    out.push({
      role: 'assistant',
      content: [{ type: 'text', text: pendingAssistantText }],
      api,
      provider: provider.id,
      model: provider.model,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: pendingAssistantTs ?? Date.now(),
    })
    pendingAssistantText = ''
    pendingAssistantTs = null
  }

  for (const row of rows) {
    const e = row.event
    if (e.kind === 'message.created') {
      flushAssistant()
      out.push({ role: 'user', content: e.prompt, timestamp: e.ts })
      continue
    }
    if (e.kind === 'message.progress') {
      const task = e.event
      if (task.kind === 'llm.message') {
        if (task.role === 'assistant') {
          // Coalesce consecutive assistant chunks (streaming emit flushes at
          // sentence boundaries — task-segments.ts does the same).
          if (!pendingAssistantTs) pendingAssistantTs = task.ts
          pendingAssistantText += typeof task.content === 'string' ? task.content : JSON.stringify(task.content)
        } else if (task.role === 'user') {
          // A forwarded user event (e.g. submitPrompt's post-launch emit).
          flushAssistant()
          out.push({
            role: 'user',
            content: typeof task.content === 'string' ? task.content : JSON.stringify(task.content),
            timestamp: task.ts,
          })
        }
      }
      // tool.call / tool.result / reasoning / error are skipped (minimal fidelity).
      continue
    }
    // Any non-message-progress event flushes the pending assistant bubble so a
    // later user turn doesn't get glued onto it.
    flushAssistant()
  }
  flushAssistant()
  return out
}

export function createSessionService(cfg: SessionServiceConfig): SessionService {
  const { store, broadcaster } = cfg
  const toolRegistry = cfg.toolRegistry ?? buildDefaultRegistry()
  const sessions = new Map<string, SessionState>()
  // Service-lifetime guard: run_events has NO foreign key on session_id, so a
  // background run's post-delete append would otherwise silently INSERT an
  // orphan row (not a no-op). This is what makes deleteSession's persistence
  // cutoff real; W4's migration should sweep any historical orphans.
  const deletedSessions = new Set<string>()

  // Inject the available-skills list and sub-agent-type catalog into the agent's
  // system prompt at task time, so newly-added skills/agents appear without a restart.
  const withPrompt = (def: AgentDefinition): AgentDefinition => {
    let systemPrompt = def.systemPrompt
    if (cfg.skillStore) {
      const isEnabled = cfg.isSkillEnabled ?? (() => true)
      systemPrompt = withSkills(
        systemPrompt,
        cfg.skillStore.list().filter((s) => isEnabled(s.name))
      )
    }
    if (cfg.agentStore) systemPrompt = withAgentTypes(systemPrompt, cfg.agentStore.list())
    return { ...def, systemPrompt }
  }

  // Read the user-configured per-task budgets at task-creation time; defaults
  // apply when no getter is wired (tests/scripts).
  const budgets = (): BudgetConfig => cfg.getBudgetConfig?.() ?? defaultBudgetConfig()

  // The permission gate is resolved live from the session's persisted settings
  // at each tool call, so toggling the composer's permission mode takes effect
  // on any in-flight or queued run in the session. Defaults to 'ask'.
  const resolvePermissionMode = (sid: string): PermissionMode => store.getSessionSettings(sid)?.permissionMode ?? 'ask'
  const directory = createAgentDirectory({ listAgentDefs: () => cfg.agentStore?.list() ?? [] })

  const seqCounter = createSeqCounter((sid: string) => store.getMessageEvents(sid))
  const terminalRegistry = createTerminalRegistry(store.getTerminalMessageStatuses())

  // Session-level planState: event-replay-derived cache of the Leader's
  // delegation DAG + per-item status/result. Holds NO context here — the
  // MessageSpec callbacks (onDelegationPlan / onDelegationUpdate) wired below
  // are the ONLY mutators; launch.ts ctx just emits + delegates to them.
  const planStates = new Map<string, Map<string, PlanItemState>>()
  /** Lazy-load: replay delegation events from the store on first access. */
  const ensurePlanState = (sessionId: string): Map<string, PlanItemState> => {
    let state = planStates.get(sessionId)
    if (state) return state
    const events = store.getMessageEvents(sessionId).map((r) => r.event)
    state = replayDelegationEvents(events as Array<{ kind: string; [k: string]: unknown }>)
    planStates.set(sessionId, state)
    return state
  }
  const setDelegationPlanForSession = (sessionId: string, plan: DelegationItem[]): void => {
    const state = applyDelegationPlan(planStates.get(sessionId), plan)
    planStates.set(sessionId, state)
  }
  const mergeDelegationResultForSession = (
    sessionId: string,
    itemId: string,
    delta: { status: DelegationItemStatus; artifacts: Artifact[] }
  ): void => {
    const state = ensurePlanState(sessionId)
    // The callback's `delta.artifacts` maps to the reducer's `result` field name.
    const next = applyDelegationUpdate(state, { itemId, status: delta.status, result: delta.artifacts })
    planStates.set(sessionId, next)
  }

  // The ONE emit-port adapter, shared by every message. Persists each message.* event
  // to message_events, marks the first-wins terminal registry, broadcasts on the wire.
  const emitPorts: MessageEmitPorts = {
    nextSeq: (sid) => seqCounter.nextSeq(sid),
    appendEvent: (evt) => {
      // Deleted-session guard: skip persistence only — markTerminal/broadcast
      // are separate port calls in createMessageEmit and proceed unaffected.
      if (deletedSessions.has(evt.sessionId)) {
        log.debug({ msg: 'message event dropped for deleted session', messageId: evt.messageId, kind: evt.kind })
        return
      }
      store.appendMessageEvent(evt.sessionId, evt.messageId, evt.parentMessageId ?? null, evt)
    },
    markTerminal: (messageId, status) => terminalRegistry.markTerminal(messageId, status),
    broadcast: (evt) => {
      broadcaster.broadcast(evt.kind, evt)
      // Hooks sink: fire-and-forget alongside the wire broadcast. Guarded so
      // a throwing dispatcher can never reject the emit path.
      try {
        cfg.dispatchHook?.(evt.kind, evt)
      } catch (err) {
        log.warn({
          msg: 'dispatchHook threw',
          kind: evt.kind,
          messageId: evt.messageId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }

  // The permission registry emits the `message.permission_request` event for
  // whichever message is currently prompting; its messageId rides on the payload's
  // `taskId` field (there is no closure identity). This dedicated adapter ports
  // makeMessageEmit's payload-derived-messageId behavior for THIS event only: persist +
  // broadcast under the message.* vocabulary (top-level `messageId`, no `taskId`).
  const permissionEmit =
    (sessionId: string) =>
    (event: string, data: unknown): void => {
      const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
      const seq = seqCounter.nextSeq(sessionId)
      const ts = Date.now()
      const messageId = obj?.taskId as string | undefined
      const parent = (obj?.parentTaskId as string | undefined) ?? null
      // Strip the source vocabulary keys so the emitted event is pure message.*.
      const { taskId: _taskId, parentTaskId: _parentTaskId, ...rest } = obj ?? {}
      if (messageId) {
        store.appendMessageEvent(sessionId, messageId, parent, {
          kind: event,
          ...rest,
          sessionId,
          messageId,
          seq,
          ts,
        } as UIEvent)
      }
      broadcaster.broadcast(event, obj ? { ...rest, sessionId, messageId, seq, ts } : data)
      // Same hooks sink as emitPorts.broadcast — permissionEmit is the sole
      // emit path for message.permission_request, so it must dispatch hooks too.
      try {
        if (messageId) cfg.dispatchHook?.(event, { ...rest, sessionId, messageId, seq, ts })
      } catch (err) {
        log.warn({
          msg: 'dispatchHook threw',
          kind: event,
          messageId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

  // ---- Global concurrency pool → launch's acquireSlot(signal) ---------------
  // CONTRACT (W2 final review): once `signal` aborts, resolve PROMPTLY — a
  // parked waiter that ignores the signal wedges the cancelled run and the
  // session FIFO behind it. Grants that land in the same tick as the abort are
  // handed straight back.
  let active = 0
  const waiters: Array<() => void> = []
  const releaseSlot = (): void => {
    const next = waiters.shift()
    if (next)
      next() // slot transferred to the woken waiter
    else active--
  }
  const acquireSlot = async (signal: AbortSignal): Promise<() => void> => {
    const granted = await new Promise<boolean>((resolve) => {
      if (active < cfg.maxConcurrent) {
        active++
        resolve(true)
        return
      }
      if (signal.aborted) {
        resolve(false)
        return
      }
      const grant = (): void => {
        cleanup()
        resolve(true) // the releasing run transferred its slot to us
      }
      const onAbort = (): void => {
        const i = waiters.indexOf(grant)
        if (i !== -1) {
          waiters.splice(i, 1)
          cleanup()
          resolve(false)
        }
        // else: grant already fired — the granted-then-aborted check below
        // hands the slot back.
      }
      const cleanup = (): void => signal.removeEventListener('abort', onAbort)
      waiters.push(grant)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    if (!granted) return () => undefined
    if (signal.aborted) {
      releaseSlot() // granted in the same tick as the abort: hand it back
      return () => undefined
    }
    let released = false
    return () => {
      if (released) return
      released = true
      releaseSlot()
    }
  }

  // Abort registry: launch registers the abort BEFORE any wait, so a cancel of a
  // queued run finds the handle and terminates cleanly (ledger #4).
  const aborts = new Map<string, () => void>()

  // ---- Per-session FIFO turn tickets → launch's waitTurn -------------------
  type Ticket = { messageId: string; grant: () => void }
  const turnQueues = new Map<string, { current: string | null; queue: Ticket[] }>()
  const q = (sid: string): { current: string | null; queue: Ticket[] } => {
    const existing = turnQueues.get(sid)
    if (existing) return existing
    const created = { current: null as string | null, queue: [] as Ticket[] }
    turnQueues.set(sid, created)
    return created
  }
  const pumpTurns = (sid: string): void => {
    const st = q(sid)
    if (st.current) return
    const next = st.queue.shift()
    if (!next) return
    st.current = next.messageId
    log.info({ msg: 'turn granted', sessionId: sid, messageId: next.messageId, queueDepth: st.queue.length })
    next.grant()
  }
  const waitTurn = (sid: string, messageId: string, _signal: AbortSignal): Promise<void> =>
    new Promise<void>((grant) => {
      q(sid).queue.push({ messageId, grant })
      pumpTurns(sid)
    })
  // Called when a turn's launchMessage promise settles: clear it if current, or drop
  // it from the queue if it aborted while still waiting, then pump the next one.
  // Looks up (never creates): a settlement racing a deleteSession must not
  // resurrect an empty queue entry for a session that's already gone.
  const settleTurn = (sid: string, messageId: string): void => {
    const st = turnQueues.get(sid)
    if (!st) return
    if (st.current === messageId) st.current = null
    else {
      const i = st.queue.findIndex((t) => t.messageId === messageId)
      if (i !== -1) st.queue.splice(i, 1)
    }
    pumpTurns(sid)
  }

  // The launch ports bound into every run for this session (uniform capability —
  // createTask + delegate are wired for EVERY run, killing per-path drift).
  const basePorts = (session: SessionState): LaunchPorts => ({
    emit: emitPorts,
    toolRegistry,
    permissionRegistry: session.permissionRegistry,
    acquireSlot,
    registerAbort: (id, abort) => aborts.set(id, abort),
    unregisterAbort: (id) => aborts.delete(id),
    waitTurn,
    delegate: (parentMessageId, prompt, opts) => delegate(session, parentMessageId, prompt, opts),
    createTask: (prompt, agentType) =>
      runWork(session.id, prompt, agentType ? { agentType } : {}).then((r) => ({
        messageId: r.messageId,
        status: r.status,
        summary: r.summary,
        artifacts: r.artifacts ?? [],
      })),
    writeAgent: (def) =>
      cfg.agentStore?.save(def) ?? { ok: false, code: 'no_store', message: 'agent store unavailable' },
    writeSkill: (skill) =>
      cfg.skillStore?.save(skill) ?? { ok: false, code: 'no_store', message: 'skill store unavailable' },
    findAgents: (query) => directory.find(query),
  })

  // Recursive child launch — resolve agentType/provider exactly like the old
  // spawnChild, then a nested launchMessage({ kind: 'child' }). The child's STATUS
  // survives to the tool layer (spec §4, ledger #6).
  const delegate = async (
    session: SessionState,
    parentMessageId: string,
    prompt: string,
    opts: { suggestedTools?: string[]; providerKey?: string; agentType?: string }
  ): Promise<DelegateResult & { messageId: string }> => {
    const { agentType, providerKey, suggestedTools } = opts
    // Resolve the sub-agent type; an unknown type falls back to the default.
    const def = (agentType ? cfg.agentStore?.get(agentType) : undefined) ?? DEFAULT_AGENT_DEF
    if (agentType && def.id !== agentType) {
      log.warn({ msg: 'agentType not found, falling back to default', agentType })
    }
    const lookedUp = providerKey ? cfg.getProvider(providerKey) : undefined
    if (providerKey && !lookedUp) {
      log.warn({ msg: 'providerKey not found, falling back to session provider', providerKey })
    }
    // The agent type may pin a model tier; otherwise inherit the provider's.
    // applyAgentModel preserves the provider's fallback chain.
    const resolvedProvider = applyAgentModel(lookedUp ?? session.provider, def)
    log.info({ msg: 'child delegated', sessionId: session.id, parentMessageId, agentDefId: def.id })
    const r = await launchMessage(
      {
        kind: 'child',
        sessionId: session.id,
        parentMessageId,
        agent: withPrompt(def),
        provider: resolvedProvider,
        prompt,
        budget: budgets().sub,
        tools: suggestedTools ?? allowlistForAgent(def),
        // A sub-agent inherits the session's live permission mode: once the user
        // grants 'full' for the session, delegated children must not re-prompt.
        getPermissionMode: () => resolvePermissionMode(session.id),
        maxIterationsOverride: budgets().maxIterations,
        // Path-Y injection: planState lives in this closure; launch ctx only
        // emits events and routes back here via the callback.
        onDelegationPlan: (plan) => setDelegationPlanForSession(session.id, plan),
        onDelegationUpdate: (itemId, delta) => mergeDelegationResultForSession(session.id, itemId, delta),
      },
      basePorts(session)
    )
    return { messageId: r.messageId, status: r.status, summary: r.summary, artifacts: r.artifacts ?? [] }
  }

  // Agent-authored top-level work run (delegate topLevel): a self-contained
  // run that does NOT touch the session buffer (no snapshot). Uses the main
  // budget and a plan-mode-aware allowlist.
  const runWork = async (
    sessionId: string,
    prompt: string,
    options: RunOptions = {},
    extra?: { history?: AgentMessage[] }
  ): Promise<{
    messageId: string
    status: 'completed' | 'failed' | 'cancelled'
    summary: string
    artifacts: Artifact[]
  }> => {
    const session = getOrRehydrate(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)
    const resolvedByType = options.agentType ? cfg.agentStore?.get(options.agentType) : undefined
    if (options.agentType && !resolvedByType) {
      log.warn({ msg: 'agentType not found, falling back to default', agentType: options.agentType })
    }
    const agentDef = resolvedByType ?? DEFAULT_AGENT_DEF
    const tools = options.executionMode === 'plan' ? PLAN_READONLY_ALLOWLIST : allowlistForAgent(agentDef)
    log.info({ msg: 'work run started', sessionId, agentDefId: agentDef.id, promptLen: prompt.length })
    const r = await launchMessage(
      {
        kind: 'work',
        sessionId,
        agent: withPrompt(agentDef),
        provider: session.provider,
        prompt,
        // Prior context ONLY — the prompt is NOT in history (spec D4); the
        // engine appends the user turn from spec.prompt. Forked sessions seed
        // this with the reconstructed transcript up to the fork point.
        ...(extra?.history ? { history: extra.history } : {}),
        budget: budgets().main,
        tools,
        cwd: options.cwd,
        executionMode: options.executionMode,
        // An explicit per-run override wins; otherwise inherit the session's live
        // permission mode so agent-authored work runs honor a session 'full' grant.
        getPermissionMode: () => options.permissionMode ?? resolvePermissionMode(sessionId),
        maxIterationsOverride: budgets().maxIterations,
        // Path-Y injection: planState lives in this closure; launch ctx only
        // emits events and routes back here via the callback.
        onDelegationPlan: (plan) => setDelegationPlanForSession(sessionId, plan),
        onDelegationUpdate: (itemId, delta) => mergeDelegationResultForSession(sessionId, itemId, delta),
      },
      basePorts(session)
    )
    log.info({ msg: 'work run finished', sessionId, messageId: r.messageId, status: r.status })
    return { messageId: r.messageId, status: r.status, summary: r.summary, artifacts: r.artifacts ?? [] }
  }

  const getOrRehydrate = (sessionId: string): SessionState | undefined => {
    const live = sessions.get(sessionId)
    if (live) return live
    const stored = store.getSession(sessionId)
    if (!stored) return undefined
    const rehydrated: SessionState = {
      id: sessionId,
      provider: stored.providerSnapshot,
      permissionRegistry: createPermissionRegistry(permissionEmit(sessionId)),
      messages: store.getAgentSnapshot(sessionId),
    }
    store.updateSessionStatus(sessionId, 'active')
    sessions.set(sessionId, rehydrated)
    return rehydrated
  }

  // Fork a session at a checkpoint: create a new session sharing the source's
  // provider, reconstruct the transcript up to (and including) the fork point
  // as prior context, and launch a work run with `newPrompt` on top of it.
  // Defined as a closure (not a method) so it can compose with createSession /
  // runWork / getOrRehydrate without `this`-binding gymnastics across the
  // returned service literal.
  const forkToNewSession = (
    sourceSessionId: string,
    forkPointMessageId: string,
    newPrompt: string,
    opts?: { agentType?: string }
  ): { sessionId: string; messageId: string } => {
    // 1. Resolve the source session (live or rehydrated) for its provider.
    const sourceSession = getOrRehydrate(sourceSessionId)
    if (!sourceSession) throw new Error(`session not found: ${sourceSessionId}`)

    // 2. Slice the source's event stream up to AND INCLUDING the fork point.
    //    Rows arrive in insertion order, so a linear scan with a break on the
    //    fork messageId captures the terminal boundary. If the fork point is
    //    never seen (stale id / race with deletion), we fork from the whole
    //    transcript — same outcome as forking at the latest message.
    const rows = store.getMessageEvents(sourceSessionId)
    const slicedEvents: Array<{ messageId: string; event: UIEvent }> = []
    let sawForkPoint = false
    for (const row of rows) {
      slicedEvents.push({ messageId: row.messageId, event: row.event })
      if (row.messageId === forkPointMessageId) {
        sawForkPoint = true
        break
      }
    }
    if (!sawForkPoint) {
      log.warn({
        msg: 'fork point messageId not found in source session; forking from whole transcript',
        sourceSessionId,
        forkPointMessageId,
      })
    }

    // 3. Reconstruct AgentMessage[] prior context from the sliced events.
    const history = reconstructHistoryFromEvents(slicedEvents, sourceSession.provider)

    // 4. Mint the new session id and persist it — mirrors the createSession
    //    method's persistence path (store row + live SessionState + broadcast)
    //    without invoking the method itself (avoiding `this`/forward-ref issues
    //    inside the returned literal). Keeps the system-session provider-refresh
    //    side effect; a fork should behave like any other fresh session.
    const sessionId = ulid()
    store.createSession(sessionId, sourceSession.provider)
    const newSession: SessionState = {
      id: sessionId,
      provider: sourceSession.provider,
      permissionRegistry: createPermissionRegistry(permissionEmit(sessionId)),
      messages: [],
      forkedFrom: { sessionId: sourceSessionId, messageId: forkPointMessageId },
    }
    sessions.set(sessionId, newSession)
    broadcaster.broadcast('session.created', { sessionId, title: null, ts: Date.now() })
    if (store.getSession(SYSTEM_SESSION_ID)) {
      store.updateSessionProvider(SYSTEM_SESSION_ID, sourceSession.provider)
      const liveSystem = sessions.get(SYSTEM_SESSION_ID)
      if (liveSystem) liveSystem.provider = sourceSession.provider
    }

    log.info({
      msg: 'session forked',
      sourceSessionId,
      forkPointMessageId,
      newSessionId: sessionId,
      historyLen: history.length,
    })

    // 5. Launch a work run with the sliced history as prior context. Fire-
    //    and-forget: forkToNewSession is synchronous (it must return the new
    //    session id immediately so the renderer can navigate to it); the run
    //    proceeds in the background and mints its own messageId on dispatch.
    //    The returned messageId is left empty when we cannot know it yet
    //    (launchMessage mints one internally); the renderer can list the new
    //    session's events to find the fork's first message.
    const runOpts = opts?.agentType ? { agentType: opts.agentType } : {}
    void runWork(sessionId, newPrompt, runOpts, { history }).catch((err) => {
      log.error({
        msg: 'fork run failed',
        sessionId,
        sourceSessionId,
        err: err instanceof Error ? err.message : String(err),
      })
    })

    return { sessionId, messageId: '' }
  }

  // Interrupted-on-restart recovery. Runs synthesize a terminal close-out per
  // orphaned run (started but never reached a terminal event) so renderer replay
  // reaches terminal instead of a stuck 'running'. Reads BOTH vocabularies:
  // pre-W4 rows are task.*, post-W4 rows are run.*; the synthetic close-out is
  // always a run.error code 'cancelled' (the post-migration shape). Idempotent:
  // a run with a terminal event is skipped by construction.
  const markInterruptedRunsTerminal = (): void => {
    const interrupted = store.listSessions().filter((s) => s.status === 'interrupted')
    if (interrupted.length === 0) return
    let closed = 0
    for (const s of interrupted) {
      const rows = store.getMessageEvents(s.id)
      const started = new Set<string>()
      const terminal = new Set<string>()
      for (const r of rows) {
        const kind = (r.event as { kind?: string }).kind
        if (kind === 'task.created' || kind === 'message.created') started.add(r.messageId)
        else if (
          kind === 'task.complete' ||
          kind === 'task.error' ||
          kind === 'message.complete' ||
          kind === 'message.error'
        )
          terminal.add(r.messageId)
      }
      for (const messageId of started) {
        if (terminal.has(messageId)) continue
        const seq = seqCounter.nextSeq(s.id)
        const ts = Date.now()
        store.appendMessageEvent(s.id, messageId, null, {
          kind: 'message.error',
          sessionId: s.id,
          messageId,
          // 'cancelled' keeps the reducer, the registry, and getTerminalMessageStatuses
          // (next restart) all in sync.
          error: { code: 'cancelled', message: 'run interrupted by restart', tier: 'fatal' },
          seq,
          ts,
        } as unknown as UIEvent)
        terminalRegistry.markTerminal(messageId, 'cancelled')
        closed += 1
      }
    }
    if (closed > 0) log.info({ msg: 'interrupted runs closed on restart', count: closed })
  }

  // Mark any sessions left 'active' from a previous run as interrupted. Do not
  // broadcast here: at startup no renderer is connected.
  for (const s of store.getInterruptedSessions()) {
    store.updateSessionStatus(s.id, 'interrupted')
  }

  return {
    createSession(provider) {
      const sessionId = ulid()
      store.createSession(sessionId, provider)
      const permissionRegistry = createPermissionRegistry(permissionEmit(sessionId))
      sessions.set(sessionId, { id: sessionId, provider, permissionRegistry, messages: [] })
      broadcaster.broadcast('session.created', { sessionId, title: null, ts: Date.now() })
      log.info({ msg: 'session created', sessionId })
      // Keep the long-lived system session's provider current.
      if (store.getSession(SYSTEM_SESSION_ID)) {
        store.updateSessionProvider(SYSTEM_SESSION_ID, provider)
        const liveSystem = sessions.get(SYSTEM_SESSION_ID)
        if (liveSystem) liveSystem.provider = provider
      }
      return { sessionId }
    },

    ensureSystemSession(fromSessionId) {
      const from = getOrRehydrate(fromSessionId)
      if (!from) throw new Error(`cannot bootstrap system session: source session ${fromSessionId} not found`)
      const existing = store.getSession(SYSTEM_SESSION_ID)
      if (existing) {
        store.updateSessionProvider(SYSTEM_SESSION_ID, from.provider)
        const live = sessions.get(SYSTEM_SESSION_ID)
        if (live) live.provider = from.provider
        log.debug({ msg: 'system session provider refreshed', fromSessionId })
      } else {
        store.createSession(SYSTEM_SESSION_ID, from.provider)
        sessions.set(SYSTEM_SESSION_ID, {
          id: SYSTEM_SESSION_ID,
          provider: from.provider,
          permissionRegistry: createPermissionRegistry(permissionEmit(SYSTEM_SESSION_ID)),
          messages: [],
        })
        store.setSessionTitle(SYSTEM_SESSION_ID, 'Scheduled tasks')
        log.info({ msg: 'system session created', fromSessionId })
      }
      return SYSTEM_SESSION_ID
    },

    submitPrompt(sessionId, prompt, attachmentsArg, onComplete, options) {
      const session = getOrRehydrate(sessionId)
      if (!session) throw new Error(`session ${sessionId} not found`)

      const attachments = attachmentsArg ?? []
      const messageId = ulid()

      // Resolve agent definition: options.agentType, then DEFAULT_AGENT_DEF.
      const resolvedByType = options?.agentType ? cfg.agentStore?.get(options.agentType) : undefined
      if (options?.agentType && !resolvedByType) {
        log.warn({ msg: 'agentType not found, falling back to default', agentType: options.agentType })
      }
      const agentDef = resolvedByType ?? DEFAULT_AGENT_DEF
      // Plan mode forces the read-only tool set even for a conversation turn.
      const tools = options?.executionMode === 'plan' ? PLAN_READONLY_ALLOWLIST : allowlistForAgent(agentDef)

      const spec: MessageSpec = {
        kind: 'turn',
        messageId,
        sessionId,
        agent: withPrompt(agentDef),
        provider: session.provider,
        prompt,
        // Prior context ONLY — the prompt is NOT in history (spec D4); the
        // engine appends the user turn from spec.prompt.
        history: session.messages,
        attachments,
        budget: budgets().main,
        tools,
        cwd: options?.cwd,
        executionMode: options?.executionMode,
        permissionMode: options?.permissionMode,
        getPermissionMode: () => resolvePermissionMode(sessionId),
        saveSnapshot: (messages) => {
          session.messages = messages
          store.saveAgentSnapshot(sessionId, messages)
        },
        maxIterationsOverride: budgets().maxIterations,
        // Path-Y injection: planState lives in this closure; launch ctx only
        // emits events and routes back here via the callback.
        onDelegationPlan: (plan) => setDelegationPlanForSession(sessionId, plan),
        onDelegationUpdate: (itemId, delta) => mergeDelegationResultForSession(sessionId, itemId, delta),
      }

      // Fire the run IMMEDIATELY so run.created renders as a pending card. This
      // runs synchronously up to launchMessage's first await, which emits run.created
      // and pushes the FIFO ticket before returning the pending promise.
      const done = launchMessage(spec, basePorts(session))

      // The user message is a first-class, seq'd run.progress event rendered in
      // true causal position — right after run.created, before dispatch (port of
      // the 4c behavior). Guarded: a throwing store here must not escape to the
      // dispatcher while the run is already streaming (Minor #3).
      try {
        createMessageEmit(emitPorts, { sessionId, messageId })({
          kind: 'message.progress',
          event: { kind: 'llm.message', role: 'user', content: prompt, ts: Date.now() },
        })
        store.updateSessionLastActive(sessionId)

        // First prompt titles the session.
        if (!store.getSession(sessionId)?.title) {
          const title = prompt.slice(0, 60)
          store.setSessionTitle(sessionId, title)
          broadcaster.broadcast('session.updated', { sessionId, title, lastActiveAt: Date.now(), ts: Date.now() })
        }
      } catch (err) {
        log.error({
          msg: 'post-launch bookkeeping failed',
          sessionId,
          messageId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
      log.info({
        msg: 'conversation turn submitted',
        sessionId,
        messageId,
        agentDefId: agentDef.id,
        cwd: options?.cwd ?? null,
        permissionMode: options?.permissionMode ?? 'ask',
        executionMode: options?.executionMode ?? 'direct',
      })

      // launchMessage never rejects; on settlement advance the FIFO + notify caller.
      void done.then((r) => {
        settleTurn(sessionId, messageId)
        try {
          onComplete?.(r.status)
        } catch (err) {
          log.error({
            msg: 'submitPrompt onComplete threw',
            sessionId,
            messageId,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      })

      return { messageId }
    },

    runWork(sessionId, prompt, options) {
      return runWork(sessionId, prompt, options)
    },

    forkToNewSession(sourceSessionId, forkPointMessageId, newPrompt, opts) {
      return forkToNewSession(sourceSessionId, forkPointMessageId, newPrompt, opts)
    },

    resolvePermission(sessionId, actionId, decision) {
      sessions.get(sessionId)?.permissionRegistry.resolve(actionId, decision)
    },

    cancelMessage(sessionId, messageId) {
      log.info({ msg: 'run cancel requested', sessionId, messageId })
      // Launch registers the abort BEFORE its waits, so a queued run cancels
      // cleanly through the same handle — no queued-branch needed (ledger #4).
      const abort = aborts.get(messageId)
      if (abort) {
        abort()
        return
      }
      log.warn({ msg: 'cancelMessage: unknown or already-finished run', sessionId, messageId })
    },

    promoteQueuedMessage(sessionId, messageId) {
      const st = turnQueues.get(sessionId)
      const idx = st ? st.queue.findIndex((t) => t.messageId === messageId) : -1
      if (!st || idx === -1) {
        log.warn({ msg: 'promoteQueuedMessage: run not in queue', sessionId, messageId })
        return
      }
      // Promote the chosen ticket to the front of the queue.
      const [item] = st.queue.splice(idx, 1)
      st.queue.unshift(item)
      const cancelledRunId = st.current
      log.info({ msg: 'run interrupted, promoted to front', sessionId, messageId, cancelledRunId })
      if (cancelledRunId) {
        // Abort the running run; its launchMessage settles cancelled (partial output
        // already saved via saveSnapshot), settleTurn clears current and pumps
        // the promoted ticket.
        aborts.get(cancelledRunId)?.()
      } else {
        // Idle session — grant the promoted ticket immediately.
        pumpTurns(sessionId)
      }
    },

    deleteSession(sessionId) {
      log.info({ msg: 'session deleted', sessionId })
      // Mark deleted BEFORE aborting in-flight runs: run_events has no FK on
      // session_id, so without this guard a background run's post-abort event
      // would silently INSERT an orphan row — this in-memory set is what
      // actually cuts off persistence.
      deletedSessions.add(sessionId)
      const st = turnQueues.get(sessionId)
      if (st) {
        if (st.current) aborts.get(st.current)?.()
        for (const t of st.queue) aborts.get(t.messageId)?.()
      }
      sessions.delete(sessionId)
      turnQueues.delete(sessionId)
      store.deleteSession(sessionId)
    },

    renameSession(sessionId, title) {
      store.setSessionTitle(sessionId, title)
    },

    setSessionPinned(sessionId, pinned) {
      store.setSessionPinned(sessionId, pinned)
    },

    updateSessionSettings(sessionId, settings) {
      // Persisting is all that's needed for the permission gate to follow the
      // toggle: the engine resolves permissionMode live from these settings on
      // each tool call, so any in-flight or queued run picks up the change.
      store.setSessionSettings(sessionId, settings)
      log.info({
        msg: 'session settings updated',
        sessionId,
        cwd: settings.cwd ?? null,
        permissionMode: settings.permissionMode ?? null,
        executionMode: settings.executionMode ?? null,
        agentType: settings.agentType ?? null,
      })
    },

    reorderSessions(orderedIds) {
      store.reorderSessions(orderedIds)
    },

    listSessions() {
      return store.listSessions()
    },

    getMessageEvents(sessionId) {
      return store.getMessageEvents(sessionId)
    },

    async exportSessionMarkdown(sessionId) {
      const rows = store.getMessageEvents(sessionId)
      const md = buildMarkdown(rows)
      const dir = cfg.exportsDir
      if (!dir) throw new Error('exportSessionMarkdown: exportsDir not configured')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${sessionId}-${Date.now()}.md`)
      await writeFile(file, md, 'utf8')
      log.info({ msg: 'session exported', sessionId, path: file })
      return { path: file }
    },

    getUsageStats(rangeDays) {
      return store.getUsageStats(rangeDays)
    },

    terminalRegistry,

    markInterruptedRunsTerminal,
  }
}
