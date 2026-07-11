import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createLogger } from '@shared/logger'
import type {
  AgentDefinition,
  Attachment,
  DelegateResult,
  PermissionDecision,
  PermissionMode,
  ProviderInjection,
  RunOptions,
  UIEvent,
} from '@swarm/protocol'
import { allowlistForAgent, type BudgetConfig, defaultBudgetConfig } from '@swarm/protocol'
import { applyAgentModel, DEFAULT_AGENT_DEF, SYSTEM_SESSION_ID } from '@swarm/shared'
import { ulid } from 'ulid'

import { withAgentTypes } from '../agents/prompt'
import type { AgentStore } from '../agents/store'
import { buildMarkdown } from '../conversation/markdown-export'
import type { ConversationStore } from '../conversation/store'
import { createAgentDirectory } from '../directory/receptionist'
import type { Broadcaster } from '../ipc/broadcaster'
import { createRunEmit, type RunEmitPorts } from '../run-engine/emit'
import { type LaunchPorts, launchRun, type RunSpec } from '../run-engine/launch'
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
  ): { runId: string }
  runWork(
    sessionId: string,
    goal: string,
    options?: RunOptions
  ): Promise<{ runId: string; status: string; summary: string }>
  resolvePermission(sessionId: string, actionId: string, decision: PermissionDecision): void
  cancelRun(sessionId: string, runId: string): void
  promoteQueuedRun(sessionId: string, runId: string): void
  deleteSession(sessionId: string): void
  renameSession(sessionId: string, title: string): void
  setSessionPinned(sessionId: string, pinned: boolean): void
  updateSessionSettings(sessionId: string, settings: import('@swarm/protocol').SessionSettings): void
  reorderSessions(orderedIds: string[]): void
  listSessions(): import('@swarm/protocol').SessionSummary[]
  getRunEvents(sessionId: string): import('@swarm/protocol').RunEvent[]
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

  const seqCounter = createSeqCounter((sid: string) => store.getRunEvents(sid))
  const terminalRegistry = createTerminalRegistry(store.getTerminalRunStatuses())

  // The ONE emit-port adapter, shared by every run. Persists each run.* event
  // to run_events, marks the first-wins terminal registry, broadcasts on the wire.
  const emitPorts: RunEmitPorts = {
    nextSeq: (sid) => seqCounter.nextSeq(sid),
    appendEvent: (evt) => {
      // Deleted-session guard: skip persistence only — markTerminal/broadcast
      // are separate port calls in createRunEmit and proceed unaffected.
      if (deletedSessions.has(evt.sessionId)) {
        log.debug({ msg: 'run event dropped for deleted session', runId: evt.runId, kind: evt.kind })
        return
      }
      store.appendRunEvent(evt.sessionId, evt.runId, evt.parentRunId ?? null, evt)
    },
    markTerminal: (runId, status) => terminalRegistry.markTerminal(runId, status),
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
          runId: evt.runId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }

  // The permission registry emits the `run.permission_request` event for
  // whichever run is currently prompting; its runId rides on the payload's
  // `taskId` field (there is no closure identity). This dedicated adapter ports
  // makeRunEmit's payload-derived-runId behavior for THIS event only: persist +
  // broadcast under the run.* vocabulary (top-level `runId`, no `taskId`).
  const permissionEmit =
    (sessionId: string) =>
    (event: string, data: unknown): void => {
      const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
      const seq = seqCounter.nextSeq(sessionId)
      const ts = Date.now()
      const runId = obj?.taskId as string | undefined
      const parent = (obj?.parentTaskId as string | undefined) ?? null
      // Strip the source vocabulary keys so the emitted event is pure run.*.
      const { taskId: _taskId, parentTaskId: _parentTaskId, ...rest } = obj ?? {}
      if (runId) {
        store.appendRunEvent(sessionId, runId, parent, {
          kind: event,
          ...rest,
          sessionId,
          runId,
          seq,
          ts,
        } as UIEvent)
      }
      broadcaster.broadcast(event, obj ? { ...rest, sessionId, runId, seq, ts } : data)
      // Same hooks sink as emitPorts.broadcast — permissionEmit is the sole
      // emit path for run.permission_request, so it must dispatch hooks too.
      try {
        if (runId) cfg.dispatchHook?.(event, { ...rest, sessionId, runId, seq, ts })
      } catch (err) {
        log.warn({
          msg: 'dispatchHook threw',
          kind: event,
          runId,
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
  type Ticket = { runId: string; grant: () => void }
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
    st.current = next.runId
    log.info({ msg: 'turn granted', sessionId: sid, runId: next.runId, queueDepth: st.queue.length })
    next.grant()
  }
  const waitTurn = (sid: string, runId: string, _signal: AbortSignal): Promise<void> =>
    new Promise<void>((grant) => {
      q(sid).queue.push({ runId, grant })
      pumpTurns(sid)
    })
  // Called when a turn's launchRun promise settles: clear it if current, or drop
  // it from the queue if it aborted while still waiting, then pump the next one.
  // Looks up (never creates): a settlement racing a deleteSession must not
  // resurrect an empty queue entry for a session that's already gone.
  const settleTurn = (sid: string, runId: string): void => {
    const st = turnQueues.get(sid)
    if (!st) return
    if (st.current === runId) st.current = null
    else {
      const i = st.queue.findIndex((t) => t.runId === runId)
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
    delegate: (parentRunId, goal, opts) => delegate(session, parentRunId, goal, opts),
    createTask: (goal, agentType) =>
      runWork(session.id, goal, agentType ? { agentType } : {}).then((r) => ({
        runId: r.runId,
        status: r.status,
        summary: r.summary,
        artifacts: [],
      })),
    writeAgent: (def) =>
      cfg.agentStore?.save(def) ?? { ok: false, code: 'no_store', message: 'agent store unavailable' },
    writeSkill: (skill) =>
      cfg.skillStore?.save(skill) ?? { ok: false, code: 'no_store', message: 'skill store unavailable' },
    findAgents: (query) => directory.find(query),
  })

  // Recursive child launch — resolve agentType/provider exactly like the old
  // spawnChild, then a nested launchRun({ kind: 'child' }). The child's STATUS
  // survives to the tool layer (spec §4, ledger #6).
  const delegate = async (
    session: SessionState,
    parentRunId: string,
    goal: string,
    opts: { suggestedTools?: string[]; providerKey?: string; agentType?: string }
  ): Promise<DelegateResult & { runId: string }> => {
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
    log.info({ msg: 'child delegated', sessionId: session.id, parentRunId, agentDefId: def.id })
    const r = await launchRun(
      {
        kind: 'child',
        sessionId: session.id,
        parentRunId,
        agent: withPrompt(def),
        provider: resolvedProvider,
        prompt: goal,
        budget: budgets().sub,
        tools: suggestedTools ?? allowlistForAgent(def),
        // A sub-agent inherits the session's live permission mode: once the user
        // grants 'full' for the session, delegated children must not re-prompt.
        getPermissionMode: () => resolvePermissionMode(session.id),
        maxIterationsOverride: budgets().maxIterations,
      },
      basePorts(session)
    )
    return { runId: r.runId, status: r.status, summary: r.summary, artifacts: [] }
  }

  // Agent-authored top-level work run (delegate topLevel): a self-contained
  // run that does NOT touch the session buffer (no snapshot). Uses the main
  // budget and a plan-mode-aware allowlist.
  const runWork = async (
    sessionId: string,
    goal: string,
    options: RunOptions = {}
  ): Promise<{ runId: string; status: 'completed' | 'failed' | 'cancelled'; summary: string }> => {
    const session = getOrRehydrate(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)
    const resolvedByType = options.agentType ? cfg.agentStore?.get(options.agentType) : undefined
    if (options.agentType && !resolvedByType) {
      log.warn({ msg: 'agentType not found, falling back to default', agentType: options.agentType })
    }
    const agentDef = resolvedByType ?? DEFAULT_AGENT_DEF
    const tools = options.executionMode === 'plan' ? PLAN_READONLY_ALLOWLIST : allowlistForAgent(agentDef)
    log.info({ msg: 'work run started', sessionId, agentDefId: agentDef.id, goalLen: goal.length })
    const r = await launchRun(
      {
        kind: 'work',
        sessionId,
        agent: withPrompt(agentDef),
        provider: session.provider,
        prompt: goal,
        budget: budgets().main,
        tools,
        cwd: options.cwd,
        executionMode: options.executionMode,
        // An explicit per-run override wins; otherwise inherit the session's live
        // permission mode so agent-authored work runs honor a session 'full' grant.
        getPermissionMode: () => options.permissionMode ?? resolvePermissionMode(sessionId),
        maxIterationsOverride: budgets().maxIterations,
      },
      basePorts(session)
    )
    log.info({ msg: 'work run finished', sessionId, runId: r.runId, status: r.status })
    return { runId: r.runId, status: r.status, summary: r.summary }
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
      const rows = store.getRunEvents(s.id)
      const started = new Set<string>()
      const terminal = new Set<string>()
      for (const r of rows) {
        const kind = (r.event as { kind?: string }).kind
        if (kind === 'task.created' || kind === 'run.created') started.add(r.runId)
        else if (kind === 'task.complete' || kind === 'task.error' || kind === 'run.complete' || kind === 'run.error')
          terminal.add(r.runId)
      }
      for (const runId of started) {
        if (terminal.has(runId)) continue
        const seq = seqCounter.nextSeq(s.id)
        const ts = Date.now()
        store.appendRunEvent(s.id, runId, null, {
          kind: 'run.error',
          sessionId: s.id,
          runId,
          // 'cancelled' keeps the reducer, the registry, and getTerminalRunStatuses
          // (next restart) all in sync.
          error: { code: 'cancelled', message: 'run interrupted by restart', tier: 'fatal' },
          seq,
          ts,
        } as unknown as UIEvent)
        terminalRegistry.markTerminal(runId, 'cancelled')
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
      const runId = ulid()

      // Resolve agent definition: options.agentType, then DEFAULT_AGENT_DEF.
      const resolvedByType = options?.agentType ? cfg.agentStore?.get(options.agentType) : undefined
      if (options?.agentType && !resolvedByType) {
        log.warn({ msg: 'agentType not found, falling back to default', agentType: options.agentType })
      }
      const agentDef = resolvedByType ?? DEFAULT_AGENT_DEF
      // Plan mode forces the read-only tool set even for a conversation turn.
      const tools = options?.executionMode === 'plan' ? PLAN_READONLY_ALLOWLIST : allowlistForAgent(agentDef)

      const spec: RunSpec = {
        kind: 'turn',
        runId,
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
      }

      // Fire the run IMMEDIATELY so run.created renders as a pending card. This
      // runs synchronously up to launchRun's first await, which emits run.created
      // and pushes the FIFO ticket before returning the pending promise.
      const done = launchRun(spec, basePorts(session))

      // The user message is a first-class, seq'd run.progress event rendered in
      // true causal position — right after run.created, before dispatch (port of
      // the 4c behavior). Guarded: a throwing store here must not escape to the
      // dispatcher while the run is already streaming (Minor #3).
      try {
        createRunEmit(emitPorts, { sessionId, runId })({
          kind: 'run.progress',
          event: { kind: 'llm.message', role: 'user', content: prompt, ts: Date.now() },
        })
        store.updateSessionLastActive(sessionId)

        // First goal titles the session.
        if (!store.getSession(sessionId)?.title) {
          const title = prompt.slice(0, 60)
          store.setSessionTitle(sessionId, title)
          broadcaster.broadcast('session.updated', { sessionId, title, lastActiveAt: Date.now(), ts: Date.now() })
        }
      } catch (err) {
        log.error({
          msg: 'post-launch bookkeeping failed',
          sessionId,
          runId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
      log.info({
        msg: 'conversation turn submitted',
        sessionId,
        runId,
        agentDefId: agentDef.id,
        cwd: options?.cwd ?? null,
        permissionMode: options?.permissionMode ?? 'ask',
        executionMode: options?.executionMode ?? 'direct',
      })

      // launchRun never rejects; on settlement advance the FIFO + notify caller.
      void done.then((r) => {
        settleTurn(sessionId, runId)
        try {
          onComplete?.(r.status)
        } catch (err) {
          log.error({
            msg: 'submitPrompt onComplete threw',
            sessionId,
            runId,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      })

      return { runId }
    },

    runWork(sessionId, goal, options) {
      return runWork(sessionId, goal, options)
    },

    resolvePermission(sessionId, actionId, decision) {
      sessions.get(sessionId)?.permissionRegistry.resolve(actionId, decision)
    },

    cancelRun(sessionId, runId) {
      log.info({ msg: 'run cancel requested', sessionId, runId })
      // Launch registers the abort BEFORE its waits, so a queued run cancels
      // cleanly through the same handle — no queued-branch needed (ledger #4).
      const abort = aborts.get(runId)
      if (abort) {
        abort()
        return
      }
      log.warn({ msg: 'cancelRun: unknown or already-finished run', sessionId, runId })
    },

    promoteQueuedRun(sessionId, runId) {
      const st = turnQueues.get(sessionId)
      const idx = st ? st.queue.findIndex((t) => t.runId === runId) : -1
      if (!st || idx === -1) {
        log.warn({ msg: 'promoteQueuedRun: run not in queue', sessionId, runId })
        return
      }
      // Promote the chosen ticket to the front of the queue.
      const [item] = st.queue.splice(idx, 1)
      st.queue.unshift(item)
      const cancelledRunId = st.current
      log.info({ msg: 'run interrupted, promoted to front', sessionId, runId, cancelledRunId })
      if (cancelledRunId) {
        // Abort the running run; its launchRun settles cancelled (partial output
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
        for (const t of st.queue) aborts.get(t.runId)?.()
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

    getRunEvents(sessionId) {
      return store.getRunEvents(sessionId)
    },

    async exportSessionMarkdown(sessionId) {
      const rows = store.getRunEvents(sessionId)
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
