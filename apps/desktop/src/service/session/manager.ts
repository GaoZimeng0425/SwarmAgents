import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createLogger } from '@shared/logger'
import type {
  AgentDefinition,
  PermissionDecision,
  PermissionMode,
  ProviderInjection,
  ResourceBudget,
  TaskOptions,
  TaskResult,
  TaskStatus,
} from '@swarm/protocol'
import { allowlistForAgent, type BudgetConfig, defaultBudgetConfig } from '@swarm/protocol'
import { applyAgentModel, DEFAULT_AGENT_DEF, SYSTEM_SESSION_ID } from '@swarm/shared'
import { ulid } from 'ulid'

import { withAgentTypes } from '../agents/prompt'
import type { AgentStore } from '../agents/store'
import type { ConversationStore } from '../conversation/store'
import { createAgentDirectory } from '../directory/receptionist'
import type { Broadcaster } from '../ipc/broadcaster'
import { withSkills } from '../skills/prompt'
import type { SkillStore } from '../skills/store'
import { registerBuiltinTools } from '../tools/builtins'
import { createToolRegistry, type ToolRegistry } from '../tools/registry'
import { createAgentRunner } from './agent-runner'
import { createPermissionRegistry, type PermissionRegistry } from './permission-registry'
import { createSeqCounter } from './seq-counter'
import { createTerminalRegistry, type TerminalRegistry, type TerminalStatus } from './terminal-registry'

const log = createLogger({ process: 'service' }).child({ component: 'session-manager' })

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
  // update_plan only — exclude create_task, whose child could mutate.
  'agent.update_plan',
]

type QueuedTurn = { taskId: string; runTurn: () => Promise<void> }

type Session = {
  id: string
  provider: ProviderInjection
  permissionRegistry: PermissionRegistry
  messages: AgentMessage[]
  // FIFO queue of turns not yet started; the running turn is NOT in here.
  pending: QueuedTurn[]
  // taskId of the turn currently executing, or null when idle.
  running: string | null
}

type SessionManagerConfig = {
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
}

export type SessionManager = {
  createSession(provider: ProviderInjection): { sessionId: string }
  /**
   * Ensure the dedicated system session (home of all global cron jobs) exists,
   * borrowing the caller session's provider so scheduled goals can run. Created
   * on first use; the provider snapshot is refreshed on every call to stay
   * current. Returns the system session id. Throws if `fromSessionId` is unknown.
   */
  ensureSystemSession(fromSessionId: string): string
  submitGoal(
    sessionId: string,
    goal: string,
    attachments?: import('@swarm/protocol').Attachment[],
    agentDef?: AgentDefinition,
    onComplete?: (status: TaskStatus, error?: string) => void,
    options?: TaskOptions
  ): { taskId: string }
  resolvePermission(sessionId: string, actionId: string, decision: PermissionDecision): void
  cancelTask(sessionId: string, taskId: string): void
  /**
   * Promote a queued task to the front of its session queue and interrupt the
   * running task (if any), so the promoted task runs next. The interrupted task
   * is cancelled with its partial output preserved in the session history.
   */
  interruptWith(sessionId: string, taskId: string): void
  deleteSession(sessionId: string): void
  renameSession(sessionId: string, title: string): void
  setSessionPinned(sessionId: string, pinned: boolean): void
  updateSessionSettings(sessionId: string, settings: import('@swarm/protocol').SessionSettings): void
  reorderSessions(orderedIds: string[]): void
  listSessions(): import('@swarm/protocol').SessionSummary[]
  getRunEvents(sessionId: string): import('@swarm/protocol').RunEvent[]
  getUsageStats(rangeDays: number): import('@swarm/protocol').UsageStats
  /** In-memory terminal-status registry (query directly: isTerminal/getStatus). */
  terminalRegistry: TerminalRegistry
  /**
   * Startup pass for interrupted-on-restart recovery: for every session marked
   * interrupted by the store's restart cleanup, find runs that were dispatched
   * but never reached a terminal event in run_events (the process died
   * mid-flight), append a synthetic task.error to run_events (so replay reaches
   * terminal instead of stuck-running), and mark each terminal in the registry.
   */
  markInterruptedRunsTerminal(): void
  /** @internal test hook */
  __enqueueWithoutPumpForTest?(sessionId: string, goal: string): string
  /** @internal test hook: drive runWorkTask (agent-authored work task) directly. */
  __runWorkTaskForTest?(
    sessionId: string,
    goal: string,
    options?: TaskOptions
  ): Promise<{ taskId: string; result: TaskResult }>
}

// session-manager owns sensible defaults for the agent-execution subsystem
// (cf. DEFAULT_AGENT_DEF). In production index.ts injects a shared registry;
// this default keeps createSessionManager usable for tests/scripts that omit it.
function buildDefaultRegistry(): ToolRegistry {
  const r = createToolRegistry()
  registerBuiltinTools(r)
  return r
}

export function createSessionManager(cfg: SessionManagerConfig): SessionManager {
  const { store, broadcaster } = cfg
  const toolRegistry = cfg.toolRegistry ?? buildDefaultRegistry()
  const sessions = new Map<string, Session>()

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

  let activeRunners = 0
  const waitQueue: Array<() => void> = []
  // One-shot task runs, keyed by taskId, so cancelTask can abort a specific in-flight run.
  const oneShotHandles = new Map<string, AbortController>()
  // The permission gate is resolved live from the session's persisted settings
  // at each tool call (see createAgentRunner.getPermissionMode), so toggling the
  // composer's permission mode takes effect on any in-flight or queued task in
  // the session regardless of when it was flipped. Defaults to 'ask'.
  const resolvePermissionMode = (sid: string): PermissionMode => store.getSessionSettings(sid)?.permissionMode ?? 'ask'
  const directory = createAgentDirectory({ listAgentDefs: () => cfg.agentStore?.list() ?? [] })

  async function acquireSlot(): Promise<void> {
    if (activeRunners < cfg.maxConcurrent) {
      activeRunners++
      return
    }
    await new Promise<void>((resolve) => waitQueue.push(resolve))
    // Slot was transferred to us by releaseSlot — do not increment again.
  }

  function releaseSlot(): void {
    const next = waitQueue.shift()
    if (next) next()
    else activeRunners--
  }

  // Run the next queued turn for a session, one at a time. A turn's finally
  // clears `running` and re-pumps, so the queue drains in order; cancelling or
  // completing the running turn naturally advances to the next.
  const pump = (session: Session): void => {
    if (session.running) return
    const next = session.pending.shift()
    if (!next) return
    session.running = next.taskId
    log.info({ msg: 'turn started', sessionId: session.id, taskId: next.taskId, queueDepth: session.pending.length })
    // Mark this turn as the active run in the UI. The renderer reducer maps
    // task.dispatched -> status 'running'; without it the turn stays 'pending'
    // and is misclassified as a queued card. workerId is vestigial in the
    // single-process model, so it is left empty. The dispatched event also
    // persists to run_events, so a turn interrupted before reaching a terminal
    // status replays from the DB as 'running' (the interrupted-on-restart
    // startup pass appends a synthetic task.error to close it out).
    makeRunEmit(session.id, next.taskId)('task.dispatched', {
      taskId: next.taskId,
      workerId: '',
      ts: Date.now(),
    })
    void next.runTurn().finally(() => {
      session.running = null
      pump(session)
    })
  }

  // Mark any sessions left 'active' from a previous run as interrupted.
  // Do not broadcast task.error here: at startup no renderer is connected,
  // and s.id is a session id, not a task id, which would produce spurious events.
  for (const s of store.getInterruptedSessions()) {
    store.updateSessionStatus(s.id, 'interrupted')
  }

  const seqCounter = createSeqCounter((sid: string) => store.getRunEvents(sid))

  // In-memory terminal-status registry. Loaded once at construction from the
  // last terminal run_event per runId (one SQL scan), then maintained
  // incrementally by the emit path (makeRunEmit) below.
  const terminalRegistry = createTerminalRegistry(store.getTerminalRunStatuses())

  // Map a terminal emit's (event, obj) to a TerminalStatus (mirrors applyEvent).
  const terminalStatusFor = (event: string, obj: Record<string, unknown> | undefined): TerminalStatus | undefined => {
    if (event === 'task.complete') return 'completed'
    if (event === 'task.error') {
      const code =
        typeof obj?.error === 'object' && obj.error && 'code' in obj.error
          ? (obj.error as { code: unknown }).code
          : undefined
      return code === 'cancelled' ? 'cancelled' : 'failed'
    }
    return undefined
  }

  // One emit factory for every run path (conversation/work/spawn/resident/
  // permission-registry). Stamps the shared seq, tees the lifecycle to
  // run_events as UIEvents (so a replayed run reaches terminal status), marks
  // terminal on the registry (idempotent — first terminal wins), and broadcasts
  // the wire event with sessionId/taskId/seq/ts.
  //
  // `runId` is OPTIONAL: when provided (conversation/work/spawn/resident) it is
  // the authoritative taskId and `parentRunId` is taken from the closure. When
  // omitted (createPermissionRegistry, which emits permission-request events
  // for whichever task is currently running in the session), taskId and
  // parentRunId are derived from the per-event payload (`obj.taskId` /
  // `obj.parentTaskId`) — matching the legacy makeEmit behavior.
  const makeRunEmit =
    (sessionId: string, runId?: string, parentRunId: string | null = null) =>
    (event: string, data: unknown): void => {
      const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
      const seq = seqCounter.nextSeq(sessionId)
      const ts = Date.now()
      // Persist seq on the TaskEvent payload (task.progress events carry one)
      // so the per-event seq travels with it into run_events.
      if (obj?.event && typeof obj.event === 'object') (obj.event as { seq?: number }).seq = seq
      const taskId = runId ?? (obj?.taskId as string | undefined)
      const effectiveParent = runId !== undefined ? parentRunId : ((obj?.parentTaskId as string | undefined) ?? null)
      if (taskId) {
        store.appendRunEvent(sessionId, taskId, effectiveParent, {
          kind: event,
          ...(obj ?? {}),
          sessionId,
          taskId,
          seq,
          ts,
        } as import('@swarm/protocol').UIEvent)
      }
      const term = terminalStatusFor(event, obj)
      if (taskId && term) terminalRegistry.markTerminal(taskId, term)
      broadcaster.broadcast(event, obj ? { ...obj, sessionId, taskId, seq, ts } : data)
    }

  const spawnChild = async (
    sessionId: string,
    parentTaskId: string,
    newGoal: string,
    suggestedTools?: string[],
    providerKey?: string,
    agentType?: string
  ): Promise<{ childTaskId: string; result: TaskResult }> => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)

    // Resolve the sub-agent type; an unknown type falls back to the default.
    const def = (agentType ? cfg.agentStore?.get(agentType) : undefined) ?? DEFAULT_AGENT_DEF
    if (agentType && def.id !== agentType) {
      log.warn({ msg: 'agentType not found, falling back to default', agentType })
    }

    const lookedUp = providerKey ? cfg.getProvider(providerKey) : undefined
    if (providerKey && !lookedUp) {
      log.warn({ msg: 'providerKey not found, falling back to session provider', providerKey })
    }
    // The agent type may pin a model tier (model + thinking depth); otherwise
    // inherit the provider's. Preserves the provider's fallback chain.
    const baseProvider = lookedUp ?? session.provider
    const resolvedProvider = applyAgentModel(baseProvider, def)

    const childRunId = ulid()
    const now = Date.now()
    const childToolAllowlist = suggestedTools ?? allowlistForAgent(def)
    log.info({ msg: 'child spawned', sessionId, parentTaskId, childRunId, agentDefId: def.id })

    // A child needs its own task.created so the renderer opens a real run
    // record; without it the child's later events arrive for an unknown runId
    // and degrade into an "(unknown task)" stub. parentTaskId/agentDefId let the
    // UI group it as a distinct sub-agent block. Routed through makeRunEmit so the
    // tee persists it to run_events (with parentRunId) for replay.
    makeRunEmit(
      sessionId,
      childRunId,
      parentTaskId
    )('task.created', {
      taskId: childRunId,
      goal: newGoal,
      attachments: [],
      parentTaskId,
      agentDefId: def.id,
    })
    broadcaster.broadcast('task.handoff.spawned', { sessionId, parentTaskId, childRunId, ts: now })

    return new Promise<{ childTaskId: string; result: TaskResult }>((resolve) => {
      const startChild = async (): Promise<void> => {
        await acquireSlot()
        const abort = new AbortController()
        oneShotHandles.set(childRunId, abort)
        const runner = createAgentRunner({
          correlationId: childRunId,
          cwd: undefined,
          executionMode: undefined,
          budget: budgets().sub,
          toolAllowlist: childToolAllowlist,
          attachments: [],
          permissionMode: undefined,
          provider: resolvedProvider,
          agentDefinition: withPrompt(def),
          sessionId,
          getPermissionMode: () => resolvePermissionMode(sessionId),
          emit: makeRunEmit(sessionId, childRunId, parentTaskId),
          permissionRegistry: session.permissionRegistry,
          toolRegistry,
          initialMessages: [{ role: 'user', content: newGoal }] as AgentMessage[],
          signal: abort.signal,
          spawnChild: (pt, ng, st, pk, at) => spawnChild(sessionId, pt, ng, st, pk, at),
          findPeers: (q) => directory.find(q),
          writeAgent: (def) =>
            cfg.agentStore?.save(def) ?? { ok: false, code: 'no_store', message: 'agent store unavailable' },
          writeSkill: (skill) =>
            cfg.skillStore?.save(skill) ?? { ok: false, code: 'no_store', message: 'skill store unavailable' },
          maxIterationsOverride: budgets().maxIterations,
        })
        try {
          const { summary } = await runner.run()
          // The runner's translator emits task.complete/task.error (→ run_events
          // + terminalRegistry), so the child run reaches a terminal status
          // without a Task-row update.
          resolve({ childTaskId: childRunId, result: { summary, artifacts: [] } })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.error({ msg: 'spawnChild run failed', childRunId, err: message })
          // Surface the failure on the run stream so replay reaches terminal.
          makeRunEmit(
            sessionId,
            childRunId,
            parentTaskId
          )('task.error', {
            taskId: childRunId,
            error: { code: 'run_failed', message, tier: 'fatal' },
            ts: Date.now(),
          })
          // Resolve (not reject) so the parent's spawn tool gets a result and continues.
          resolve({ childTaskId: childRunId, result: { summary: '', artifacts: [] } })
        } finally {
          oneShotHandles.delete(childRunId)
          releaseSlot()
        }
      }
      void startChild()
    })
  }

  const getOrRehydrate = (sessionId: string): Session | undefined => {
    const live = sessions.get(sessionId)
    if (live) return live
    const stored = store.getSession(sessionId)
    if (!stored) return undefined
    const rehydrated: Session = {
      id: sessionId,
      provider: stored.providerSnapshot,
      permissionRegistry: createPermissionRegistry(makeRunEmit(sessionId)),
      messages: store.getAgentSnapshot(sessionId),
      pending: [],
      running: null,
    }
    store.updateSessionStatus(sessionId, 'active')
    sessions.set(sessionId, rehydrated)
    return rehydrated
  }

  // Run one task turn under an acquired concurrency slot: build the runner and
  // drive it to a terminal status, which the runner's translator emits as
  // task.complete/task.error (→ run_events + the terminal registry). Used by
  // runWorkTask (a self-contained work run that does not touch the session
  // buffer). The caller owns task.created/dispatched and supplies the explicit
  // fields the runner needs (resolved upstream).
  const runTaskTurn = async (args: {
    sessionId: string
    runId: string
    agentDef: AgentDefinition
    cwd?: string
    goal: string
    executionMode?: import('@swarm/protocol').ExecutionMode
    budget: ResourceBudget
    toolAllowlist: string[]
    attachments?: import('@swarm/protocol').Attachment[]
    permissionMode?: PermissionMode
    onComplete?: (status: TaskStatus, error?: string) => void
  }): Promise<TaskResult> => {
    const {
      sessionId,
      runId,
      agentDef,
      cwd,
      goal,
      executionMode,
      budget,
      toolAllowlist,
      attachments,
      permissionMode,
      onComplete,
    } = args
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)
    // Register the abort handle BEFORE awaiting a slot: pump() (or runWorkTask)
    // has already marked this turn running, so until the handle exists a cancel
    // issued while we wait for a slot would find the turn nowhere and no-op.
    const abort = new AbortController()
    oneShotHandles.set(runId, abort)
    await acquireSlot()
    const runner = createAgentRunner({
      correlationId: runId,
      cwd,
      executionMode,
      budget,
      toolAllowlist,
      attachments,
      permissionMode,
      provider: session.provider,
      agentDefinition: withPrompt(agentDef),
      sessionId,
      getPermissionMode: () => resolvePermissionMode(sessionId),
      emit: makeRunEmit(sessionId, runId),
      permissionRegistry: session.permissionRegistry,
      toolRegistry,
      initialMessages: [{ role: 'user', content: goal }] as AgentMessage[],
      // Work runs are isolated: they must NOT overwrite the session's shared
      // agent_snapshot buffer (which belongs to the conversation). Omitting
      // saveSnapshot is safe — the runner calls it via optional chaining — so
      // the work run's transcript lives only in run_events.
      signal: abort.signal,
      spawnChild: (pt, ng, st, pk, at) => spawnChild(sessionId, pt, ng, st, pk, at),
      findPeers: (q) => directory.find(q),
      writeAgent: (def) =>
        cfg.agentStore?.save(def) ?? { ok: false, code: 'no_store', message: 'agent store unavailable' },
      writeSkill: (skill) =>
        cfg.skillStore?.save(skill) ?? { ok: false, code: 'no_store', message: 'skill store unavailable' },
      maxIterationsOverride: budgets().maxIterations,
    })
    try {
      const { status, summary } = await runner.run()
      // The runner's translator emits task.complete/task.error (→ run_events +
      // the terminal registry), so no explicit status write is needed.
      onComplete?.(status)
      return { summary, artifacts: [] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ msg: 'runTaskTurn failed', runId, err: message })
      // Surface the failure on the run stream so replay reaches terminal.
      makeRunEmit(sessionId, runId)('task.error', {
        taskId: runId,
        error: { code: 'run_failed', message, tier: 'fatal' },
        ts: Date.now(),
      })
      onComplete?.('failed', message)
      return { summary: '', artifacts: [] }
    } finally {
      oneShotHandles.delete(runId)
      releaseSlot()
    }
  }

  // Create a top-level work run (no Task row; lives entirely in run_events)
  // and drive the runner directly — bypassing the session's one-at-a-time turn
  // pump — so a conversation turn calling create_task can await it without
  // deadlocking the pump. Used by the create_task tool (agent-authored work)
  // and the __runWorkTaskForTest seam. NOTE: spec §8 says nested runs "do not
  // re-acquire" the slot, but spawnChild (which this mirrors) in fact acquires
  // its own slot today; under the production maxConcurrent this is safe and is
  // the precedent followed here.
  const runWorkTask = async (
    sessionId: string,
    goal: string,
    attachments: import('@swarm/protocol').Attachment[] = [],
    options: TaskOptions = {},
    agentDefOverride?: AgentDefinition
  ): Promise<{ taskId: string; result: TaskResult }> => {
    const session = getOrRehydrate(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)
    const resolvedByType = options.agentType ? cfg.agentStore?.get(options.agentType) : undefined
    if (options.agentType && !resolvedByType) {
      log.warn({ msg: 'agentType not found, falling back to default', agentType: options.agentType })
    }
    const agentDef = agentDefOverride ?? resolvedByType ?? DEFAULT_AGENT_DEF
    const toolAllowlist = options.executionMode === 'plan' ? PLAN_READONLY_ALLOWLIST : allowlistForAgent(agentDef)
    const runId = ulid()
    makeRunEmit(sessionId, runId)('task.created', { taskId: runId, goal, attachments, agentDefId: agentDef.id })
    log.info({ msg: 'work run created', sessionId, runId, agentDefId: agentDef.id, goalLen: goal.length })
    // The pump would emit dispatched; since we bypass it, do so here so the
    // renderer marks the work run running (not queued). The dispatched event
    // also persists to run_events, so the run is discoverable as 'running' on
    // replay (the interrupted-on-restart pass closes it out if need be).
    makeRunEmit(sessionId, runId)('task.dispatched', { taskId: runId, workerId: '', ts: Date.now() })
    const result = await runTaskTurn({
      sessionId,
      runId,
      agentDef,
      cwd: options.cwd,
      goal,
      executionMode: options.executionMode,
      budget: budgets().main,
      toolAllowlist,
      attachments,
      permissionMode: options.permissionMode,
    })
    return { taskId: runId, result }
  }

  // Interrupted-on-restart recovery. Pre-4b the store's restart cleanup fired
  // the task-terminal listener via updateTaskStatus; post-4b that listener is
  // rewired to the registry (loaded from run_events terminal events), which
  // does NOT include runs that were dispatched but never reached a terminal
  // event (the process died mid-flight). Without this pass, renderer replay
  // shows such an orphaned run stuck 'running' forever. Fix: synthesize a
  // terminal task.error per orphan in run_events (so replay reaches terminal)
  // and mark each terminal in the registry. Idempotent: a run with a terminal event is
  // skipped by construction (it isn't an orphan).
  //
  // Queries sessions already in the 'interrupted' state — by the time this
  // runs, the manager constructor + store's markAndGetInterrupted have already
  // flipped active→interrupted, so getInterruptedSessions() (which returns only
  // the newly-flipped) would be empty.
  const markInterruptedRunsTerminal = (): void => {
    const interrupted = store.listSessions().filter((s) => s.status === 'interrupted')
    if (interrupted.length === 0) return
    let closed = 0
    for (const s of interrupted) {
      // Every run path emits task.created — conversation/work via pump's
      // task.dispatched path AND spawnChild/spawnResident which bypass pump.
      // task.dispatched alone misses spawn/resident runs, leaving their crashed
      // cards stuck on replay.
      const rows = store.getRunEvents(s.id)
      const started = new Set<string>()
      const terminal = new Set<string>()
      for (const r of rows) {
        const kind = (r.event as { kind?: string }).kind
        if (kind === 'task.created') started.add(r.runId)
        else if (kind === 'task.complete' || kind === 'task.error') terminal.add(r.runId)
      }
      for (const runId of started) {
        if (terminal.has(runId)) continue
        const seq = seqCounter.nextSeq(s.id)
        const ts = Date.now()
        // The pre-run.* engine still persists task.* events (migrated in Task 3);
        // cast keeps this synthetic terminal on the old wire until then.
        const event = {
          kind: 'task.error',
          sessionId: s.id,
          taskId: runId,
          // 'cancelled' keeps applyEvent, the registry, and getTerminalRunStatuses
          // (next restart) all in sync. 'interrupted' was never a status the
          // renderer maps; using it drifted to 'failed' on replay.
          error: { code: 'cancelled', message: 'run interrupted by restart', tier: 'fatal' },
          ts,
          seq,
        } as unknown as import('@swarm/protocol').UIEvent
        store.appendRunEvent(s.id, runId, null, event)
        // Mark terminal cancelled so waiters (and the listener wired in
        // service/index.ts) fire. Idempotent: first terminal wins.
        terminalRegistry.markTerminal(runId, 'cancelled')
        closed += 1
      }
    }
    if (closed > 0) {
      log.info({ msg: 'interrupted runs closed on restart', count: closed })
    }
  }

  return {
    createSession(provider) {
      const sessionId = ulid()
      store.createSession(sessionId, provider)
      const permissionRegistry = createPermissionRegistry(makeRunEmit(sessionId))
      sessions.set(sessionId, {
        id: sessionId,
        provider,
        permissionRegistry,
        messages: [],
        pending: [],
        running: null,
      })
      broadcaster.broadcast('session.created', { sessionId, title: null, ts: Date.now() })
      log.info({ msg: 'session created', sessionId })
      // Keep the long-lived system session's provider current: a new session
      // always carries the latest configured provider (model/key), so sync it
      // onto the system session (when it exists) — that way scheduled jobs fire
      // with up-to-date credentials without waiting for the next schedule_task.
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
        // Keep the provider current: the user may have switched model/key since
        // the system session was first created (it lives forever, unlike a chat).
        store.updateSessionProvider(SYSTEM_SESSION_ID, from.provider)
        const live = sessions.get(SYSTEM_SESSION_ID)
        if (live) live.provider = from.provider
        log.debug({ msg: 'system session provider refreshed', fromSessionId })
      } else {
        store.createSession(SYSTEM_SESSION_ID, from.provider)
        sessions.set(SYSTEM_SESSION_ID, {
          id: SYSTEM_SESSION_ID,
          provider: from.provider,
          permissionRegistry: createPermissionRegistry(makeRunEmit(SYSTEM_SESSION_ID)),
          messages: [],
          pending: [],
          running: null,
        })
        store.setSessionTitle(SYSTEM_SESSION_ID, 'Scheduled tasks')
        log.info({ msg: 'system session created', fromSessionId })
      }
      return SYSTEM_SESSION_ID
    },

    submitGoal(sessionId, goal, attachmentsArg, agentDefArg, onComplete, options) {
      const session = getOrRehydrate(sessionId)
      if (!session) throw new Error(`session ${sessionId} not found`)

      const attachments = attachmentsArg ?? []
      const turnId = ulid()

      // Resolve agent definition: explicit arg wins, then options.agentType, then
      // DEFAULT_AGENT_DEF (mirrors spawnChild / runWorkTask resolution).
      const resolvedByType = options?.agentType ? cfg.agentStore?.get(options.agentType) : undefined
      if (options?.agentType && !resolvedByType) {
        log.warn({ msg: 'agentType not found, falling back to default', agentType: options.agentType })
      }
      const agentDef = agentDefArg ?? resolvedByType ?? DEFAULT_AGENT_DEF

      // A conversation turn is NOT a Task: no row, no verify loop. It still emits
      // task.created on the run stream so the renderer's applyEvent opens the
      // RunRecord (with goal + agentDefId) before the user-message progress event
      // appends to it; the user message remains a first-class, seq'd event
      // rendered in true causal position.
      makeRunEmit(sessionId, turnId)('task.created', {
        taskId: turnId,
        goal,
        attachments,
        agentDefId: agentDef.id,
      })
      makeRunEmit(sessionId, turnId)('task.progress', {
        event: { kind: 'llm.message', role: 'user', content: goal, ts: Date.now() },
      })
      store.updateSessionLastActive(sessionId)

      // First goal titles the session (replaces the legacy first-task title).
      if (!store.getSession(sessionId)?.title) {
        const title = goal.slice(0, 60)
        store.setSessionTitle(sessionId, title)
        broadcaster.broadcast('session.updated', { sessionId, title, lastActiveAt: Date.now(), ts: Date.now() })
      }
      log.info({
        msg: 'conversation turn submitted',
        sessionId,
        turnId,
        agentDefId: agentDef.id,
        cwd: options?.cwd ?? null,
        permissionMode: options?.permissionMode ?? 'ask',
        executionMode: options?.executionMode ?? 'goal',
      })

      const runTurn = async (): Promise<void> => {
        // Register the abort handle BEFORE awaiting a slot (see runTaskTurn): a
        // cancel issued while we wait for a slot must find this turn.
        const abort = new AbortController()
        oneShotHandles.set(turnId, abort)
        await acquireSlot()
        // Plan mode forces the read-only tool set even for a conversation turn.
        const toolAllowlist = options?.executionMode === 'plan' ? PLAN_READONLY_ALLOWLIST : allowlistForAgent(agentDef)
        const runner = createAgentRunner({
          correlationId: turnId,
          cwd: options?.cwd,
          executionMode: options?.executionMode,
          budget: budgets().main,
          toolAllowlist,
          attachments,
          permissionMode: options?.permissionMode,
          provider: session.provider,
          agentDefinition: withPrompt(agentDef),
          sessionId,
          getPermissionMode: () => resolvePermissionMode(sessionId),
          emit: makeRunEmit(sessionId, turnId),
          permissionRegistry: session.permissionRegistry,
          toolRegistry,
          initialMessages: [...session.messages, { role: 'user', content: goal }] as AgentMessage[],
          saveSnapshot: (messages) => {
            session.messages = messages
            store.saveAgentSnapshot(sessionId, messages)
          },
          signal: abort.signal,
          spawnChild: (pt, ng, st, pk, at) => spawnChild(sessionId, pt, ng, st, pk, at),
          createTask: (g, agentType) => runWorkTask(sessionId, g, [], agentType ? { agentType } : {}),
          findPeers: (q) => directory.find(q),
          writeAgent: (def) =>
            cfg.agentStore?.save(def) ?? { ok: false, code: 'no_store', message: 'agent store unavailable' },
          writeSkill: (skill) =>
            cfg.skillStore?.save(skill) ?? { ok: false, code: 'no_store', message: 'skill store unavailable' },
          maxIterationsOverride: budgets().maxIterations,
        })
        try {
          const { status } = await runner.run()
          onComplete?.(status)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.error({ msg: 'conversation turn failed', turnId, err: message })
          makeRunEmit(sessionId, turnId)('task.error', {
            taskId: turnId,
            error: { code: 'run_failed', message, tier: 'fatal' },
            ts: Date.now(),
          })
          onComplete?.('failed', message)
        } finally {
          oneShotHandles.delete(turnId)
          releaseSlot()
        }
      }

      session.pending.push({ taskId: turnId, runTurn })
      pump(session)
      return { taskId: turnId }
    },

    resolvePermission(sessionId, actionId, decision) {
      sessions.get(sessionId)?.permissionRegistry.resolve(actionId, decision)
    },

    cancelTask(sessionId, taskId) {
      log.info({ msg: 'task cancel requested', sessionId, taskId })
      // Running (or about-to-run with a registered abort handle): abort the run.
      const handle = oneShotHandles.get(taskId)
      if (handle) {
        handle.abort()
        return
      }
      // Queued but not yet started: remove from the queue and emit task.error
      // (routed through makeRunEmit so it tees to run_events AND broadcasts). The
      // runner never started, so no translator emit will fire — this is the
      // sole terminal signal for the cancelled queued turn.
      const session = sessions.get(sessionId)
      const idx = session ? session.pending.findIndex((q) => q.taskId === taskId) : -1
      if (session && idx !== -1) {
        session.pending.splice(idx, 1)
        makeRunEmit(sessionId, taskId)('task.error', {
          taskId,
          error: { code: 'cancelled', message: 'Cancelled before start', tier: 'fatal' },
          ts: Date.now(),
        })
        log.info({ msg: 'queued turn cancelled', sessionId, taskId })
        return
      }
      log.warn({ msg: 'cancelTask: unknown or already-finished task', sessionId, taskId })
    },

    interruptWith(sessionId, taskId) {
      const session = sessions.get(sessionId)
      if (!session) {
        log.warn({ msg: 'interruptWith: unknown session', sessionId, taskId })
        return
      }
      const idx = session.pending.findIndex((q) => q.taskId === taskId)
      if (idx === -1) {
        log.warn({ msg: 'interruptWith: task not in queue', sessionId, taskId })
        return
      }
      // Jump the queue: move the chosen turn to the front.
      const [item] = session.pending.splice(idx, 1)
      session.pending.unshift(item)
      const cancelledTaskId = session.running
      log.info({ msg: 'task interrupted, promoted to front', sessionId, taskId, cancelledTaskId })
      if (cancelledTaskId) {
        // Abort the running task; its run returns 'cancelled' with partial
        // output already saved via saveSnapshot, and its finally re-pumps,
        // which now picks the promoted item.
        oneShotHandles.get(cancelledTaskId)?.abort()
      } else {
        // Idle session — run the promoted item immediately.
        pump(session)
      }
    },

    deleteSession(sessionId) {
      log.info({ msg: 'session deleted', sessionId })
      // Abort any in-flight runs for this session before dropping its rows.
      // Post-4b there are no Task rows to enumerate (runs live in run_events),
      // so drive the aborts from the in-memory queue + the running turn; any
      // background spawnChild/runWorkTask run will complete and its writes to
      // the deleted session are no-ops.
      const session = sessions.get(sessionId)
      if (session) {
        if (session.running) oneShotHandles.get(session.running)?.abort()
        for (const q of session.pending) oneShotHandles.get(q.taskId)?.abort()
      }
      sessions.delete(sessionId)
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
      // toggle: the runner resolves permissionMode live from these settings on
      // each tool call (resolvePermissionMode), so any in-flight or queued task
      // in the session picks up the change on its next call.
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

    getUsageStats(rangeDays) {
      return store.getUsageStats(rangeDays)
    },

    terminalRegistry,

    markInterruptedRunsTerminal,

    // Test-only: enqueue a goal WITHOUT auto-pumping, leaving the session idle
    // with a pending turn. submitGoal always pumps, so the only way to reach the
    // idle-with-pending state (exercised by interruptWith's else branch) is to
    // briefly block pump with a sentinel `running`, then clear it. Returns taskId.
    __enqueueWithoutPumpForTest(sessionId: string, goal: string): string {
      const session = sessions.get(sessionId)
      if (!session) throw new Error(`session ${sessionId} not found`)
      const prevRunning = session.running
      session.running = '__test_block__'
      const { taskId } = this.submitGoal(sessionId, goal)
      session.running = prevRunning
      return taskId
    },

    __runWorkTaskForTest(sessionId: string, goal: string, options?: TaskOptions) {
      return runWorkTask(sessionId, goal, [], options)
    },
  }
}
