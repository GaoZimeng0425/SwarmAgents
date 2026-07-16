import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { uuidv7 } from '@earendil-works/pi-agent-core'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'
import type {
  AgentDefinition,
  AgentWireEvent,
  Artifact,
  Attachment,
  DelegateResult,
  EntryRow,
  PermissionDecision,
  PermissionMode,
  ProviderInjection,
  Risk,
  RunOptions,
  RunStatus,
  SessionEntry,
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
import { composeSystemPrompt, resolveModel } from '../message-engine/models'
import { createRunHooks } from '../session-agent/run-hooks'
import { type RunResult, SessionAgent } from '../session-agent/session-agent'
import { withSkills } from '../skills/prompt'
import type { SkillStore } from '../skills/store'
import { registerBuiltinTools } from '../tools/builtins'
import { createToolRegistry, type ToolRegistry, type ToolRunContext } from '../tools/registry'
import { reportResultSpec } from '../tools/report-result'
import { createPermissionRegistry, type PermissionRegistry } from './permission-registry'

const log = createLogger({ process: 'service' }).child({ component: 'session-service' })

// Plan mode is read-only: it grants inspection tools but no shell, no fs writes,
// and no peekaboo interactions, so the agent physically cannot mutate anything
// while it produces a plan. Applies to the composer's main run only.
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

// Per-session run controller. One SessionAgent per session (spec §3.3); slot
// yield for delegate is per-session (a child rides the pool while its parent
// yields — ledger #5, ported from message-engine/launch.ts:127-139).
type SlotController = {
  acquire: (signal: AbortSignal) => Promise<() => void>
  yieldWhile: <T>(fn: () => Promise<T>) => Promise<T>
  getSignal: () => AbortSignal | undefined
}

type SessionState = {
  id: string
  provider: ProviderInjection
  permissionRegistry: PermissionRegistry
  /** Session id whose live permission mode governs this run's gate — a child
   *  inherits the root user session's id so a session-level 'full' grant flows
   *  down to delegated children (they must not re-prompt). */
  permissionSessionId: string
  slot: SlotController
  kind: 'user' | 'child'
  agent?: SessionAgent
  /** Present only for a child (delegate) session: the fixed single-shot run
   *  config, plus the artifact sink report_result writes into. */
  childRun?: {
    agentDef: AgentDefinition
    tools: string[]
    budgetKind: 'main' | 'sub'
    artifacts: Artifact[]
  }
  /** Set fresh each run by buildAgentConfig so the run-hooks factory (which runs
   *  BEFORE buildAgentConfig inside SessionAgent.runOnce) can read this run's
   *  per-call risk classifier when a tool call finally fires. */
  riskOf: (name: string, args?: unknown) => Risk
}

type SessionServiceConfig = {
  store: ConversationStore
  broadcaster: Broadcaster
  maxConcurrent: number
  getProvider(key: string): ProviderInjection | undefined
  toolRegistry?: ToolRegistry
  skillStore?: SkillStore
  agentStore?: AgentStore
  /** Returns the user-configured per-run budgets; defaults apply when omitted. */
  getBudgetConfig?: () => BudgetConfig
  /** Live predicate from the tool-toggles store; disabled skills are dropped from the catalog. */
  isSkillEnabled?: (name: string) => boolean
  /** Directory where session-markdown exports are written. Required for exportSessionMarkdown. */
  exportsDir?: string
  /**
   * Optional Claude-Code-style hooks sink. Invoked once per emitted AgentWireEvent
   * with (eventName, evt). Fire-and-forget — a throwing/slow sink must never block emit.
   */
  dispatchHook?: (eventName: string, payload: unknown) => void
  /** Test seam: inject a fake StreamFn so runs never hit the network (see session-agent.test). */
  streamFn?: StreamFn
}

export type SessionService = {
  createSession(provider: ProviderInjection): { sessionId: string }
  ensureSystemSession(fromSessionId: string): string
  submitPrompt(
    sessionId: string,
    prompt: string,
    attachments?: Attachment[],
    onComplete?: (status: RunStatus, error?: string) => void,
    options?: RunOptions
  ): { runId: string }
  /**
   * Full-fidelity fork: create a new user session sharing the source's provider
   * and copy the source's entries up to (and including) `upToRowId` — the exact
   * transcript, not a lossy reconstruction. Returns the new session id.
   */
  forkSession(sourceSessionId: string, upToRowId: number): { sessionId: string }
  /** The session's finalized entry log from `afterRowId` (exclusive; 0 = all). */
  getSessionEntries(sessionId: string, afterRowId?: number): EntryRow[]
  /** Cancel the session's active run (SessionAgent owns the abort). */
  cancelRun(sessionId: string): void
  resolvePermission(sessionId: string, actionId: string, decision: PermissionDecision): void
  deleteSession(sessionId: string): void
  renameSession(sessionId: string, title: string): void
  setSessionPinned(sessionId: string, pinned: boolean): void
  updateSessionSettings(sessionId: string, settings: import('@swarm/protocol').SessionSettings): void
  reorderSessions(orderedIds: string[]): void
  listSessions(): import('@swarm/protocol').SessionSummary[]
  /** Build a markdown transcript of the session and write it to exportsDir; returns the file path. */
  exportSessionMarkdown(sessionId: string): Promise<{ path: string }>
  getUsageStats(rangeDays: number): import('@swarm/protocol').UsageStats
  /** Diagnostics/tests: ids of sessions with live in-memory state (SessionAgent).
   *  A completed child delegate must NOT appear here (its state is freed). */
  liveSessionIds(): string[]
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

  // Inject the available-skills list and sub-agent-type catalog into the agent's
  // system prompt at run time, so newly-added skills/agents appear without a restart.
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

  const budgets = (): BudgetConfig => cfg.getBudgetConfig?.() ?? defaultBudgetConfig()

  // The permission gate is resolved live from the session's persisted settings
  // at each tool call, so toggling the composer's permission mode takes effect
  // on any in-flight run in the session. Defaults to 'ask'.
  const resolvePermissionMode = (sid: string): PermissionMode => store.getSessionSettings(sid)?.permissionMode ?? 'ask'
  const directory = createAgentDirectory({ listAgentDefs: () => cfg.agentStore?.list() ?? [] })

  const resolveAgentDef = (agentType?: string): AgentDefinition => {
    const r = agentType ? cfg.agentStore?.get(agentType) : undefined
    if (agentType && !r) log.warn({ msg: 'agentType not found, falling back to default', agentType })
    return r ?? DEFAULT_AGENT_DEF
  }

  // ---- Global concurrency pool ---------------------------------------------
  // CONTRACT (W2 final review): once `signal` aborts, resolve PROMPTLY — a
  // parked waiter that ignores the signal wedges the cancelled run. Grants that
  // land in the same tick as the abort are handed straight back.
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

  // Per-session slot handle with a re-acquirable release, so a delegate tool
  // call can yield the parent's slot while it awaits the child, then re-take one
  // before the parent's run continues. The handle SessionAgent stores reads the
  // CURRENT underlying release at call time, so a yield/re-acquire swap doesn't
  // leak or double-release.
  const makeSlotController = (): SlotController => {
    let currentRelease: (() => void) | null = null
    let currentSignal: AbortSignal | undefined
    let yieldDepth = 0

    const acquire = async (signal: AbortSignal): Promise<() => void> => {
      currentSignal = signal
      const rel = await acquireSlot(signal)
      // acquireSlot resolves with a no-op release when the signal aborted while
      // queued; SessionAgent's contract wants a REJECTION so it can settle the
      // run cancelled without ever calling the LLM (see session-agent.ts:363).
      if (signal.aborted) {
        rel()
        throw new Error('slot wait aborted')
      }
      currentRelease = rel
      return () => {
        currentRelease?.()
        currentRelease = null
        currentSignal = undefined
      }
    }

    const yieldWhile = async <T>(fn: () => Promise<T>): Promise<T> => {
      yieldDepth++
      if (yieldDepth === 1 && currentRelease) {
        currentRelease()
        currentRelease = null
      }
      try {
        return await fn()
      } finally {
        yieldDepth--
        // Re-acquire for the parent unless it was cancelled while we waited.
        if (yieldDepth === 0 && currentSignal && !currentSignal.aborted) {
          currentRelease = await acquireSlot(currentSignal)
        }
      }
    }

    return { acquire, yieldWhile, getSignal: () => currentSignal }
  }

  const broadcastWire = (e: AgentWireEvent): void => {
    broadcaster.broadcast(e.kind, e)
    // Hooks sink: fire-and-forget alongside the wire broadcast. Guarded so a
    // throwing dispatcher can never reject the emit path.
    try {
      cfg.dispatchHook?.(e.kind, e)
    } catch (err) {
      log.warn({ msg: 'dispatchHook threw', kind: e.kind, err: err instanceof Error ? err.message : String(err) })
    }
  }

  // Append a 'custom' entry to a session's log and broadcast entry_appended.
  // Replaces the old message.delegation_plan/delegation_update wire events +
  // the in-memory planStates cache (spec: delegation state lives as entries).
  const appendCustomEntry = (sessionId: string, customType: string, data: unknown): number => {
    const rows = store.entries.list(sessionId)
    const parentId = rows.length ? rows[rows.length - 1].entry.id : null
    const entry: SessionEntry = {
      type: 'custom',
      customType,
      id: uuidv7(),
      parentId,
      timestamp: new Date().toISOString(),
      data,
    }
    const rowId = store.entries.append(sessionId, entry)
    broadcastWire({ kind: 'entry_appended', sessionId, rowId, entry })
    return rowId
  }

  const makeState = (id: string, provider: ProviderInjection, kind: 'user' | 'child' = 'user'): SessionState => ({
    id,
    provider,
    permissionRegistry: createPermissionRegistry(),
    permissionSessionId: id,
    slot: makeSlotController(),
    kind,
    riskOf: () => 'medium',
  })

  // Assemble this run's tool context (moved from message-engine/launch.ts:208-242)
  // and the composed system prompt / model / thinking level / tools. Resolved
  // fresh per run so a mid-session model switch or settings change takes effect.
  const buildAgentConfig = (session: SessionState) => {
    const isChild = session.kind === 'child'
    const settings = isChild ? undefined : store.getSessionSettings(session.id)
    const agentDef = session.childRun?.agentDef ?? resolveAgentDef(settings?.agentType)
    const executionMode = isChild ? undefined : settings?.executionMode
    const cwd = isChild ? undefined : settings?.cwd
    const allowlist =
      session.childRun?.tools ?? (executionMode === 'plan' ? PLAN_READONLY_ALLOWLIST : allowlistForAgent(agentDef))

    const provider = session.provider
    const model = resolveModel(provider)
    const systemPrompt = composeSystemPrompt(withPrompt(agentDef).systemPrompt, { cwd, executionMode })
    const thinkingLevel = clampThinkingLevel(model, provider.thinkingLevel ?? 'high')

    const ctx: ToolRunContext = {
      sessionId: session.id,
      // One run at a time per session; the session id is the correlation key.
      taskId: session.id,
      cwd,
      spawnChild: (prompt, opts) => delegate(session, prompt, { ...opts, budgetKind: 'sub' }),
      createTask: (prompt, agentType) => delegate(session, prompt, { agentType, budgetKind: 'main' }),
      // Tools must NOT self-gate: permission is enforced centrally in run-hooks.
      requestPermission: () => Promise.resolve('grant' as const),
      findPeers: (q) => directory.find(q),
      writeAgent: (def) =>
        cfg.agentStore?.save(def) ?? { ok: false, code: 'no_store', message: 'agent store unavailable' },
      writeSkill: (skill) =>
        cfg.skillStore?.save(skill) ?? { ok: false, code: 'no_store', message: 'skill store unavailable' },
      setDelegationPlan: (plan) => void appendCustomEntry(session.id, 'delegation_plan', { plan }),
      mergeDelegationResult: (itemId, delta) =>
        void appendCustomEntry(session.id, 'delegation_update', {
          itemId,
          status: delta.status,
          result: delta.artifacts,
        }),
      // report_result is a per-run sink for a child agent's structured results.
      reportResult: session.childRun ? (artifacts) => session.childRun?.artifacts.push(...artifacts) : undefined,
    }

    const { tools, riskOf } = toolRegistry.resolve(allowlist, ctx)
    session.riskOf = riskOf
    if (tools.length === 0) log.warn({ msg: 'no tools resolved for run', sessionId: session.id, allowlist })
    // report_result is runtime infrastructure for child runs — always injected,
    // bypassing the allowlist. It's how children submit structured results.
    const finalTools = isChild ? [...tools, reportResultSpec().build(ctx)] : tools

    const budgetCfg = budgets()
    return {
      systemPrompt,
      model,
      apiKey: provider.apiKey,
      thinkingLevel,
      tools: finalTools,
      maxTurns: budgetCfg.maxIterations ?? agentDef.maxIterations ?? 25,
      ...(cfg.streamFn ? { streamFn: cfg.streamFn } : {}),
    }
  }

  const getOrCreateAgent = (session: SessionState): SessionAgent => {
    if (session.agent) return session.agent
    const agent: SessionAgent = new SessionAgent({
      sessionId: session.id,
      entries: store.entries,
      broadcast: broadcastWire,
      acquireSlot: session.slot.acquire,
      buildAgentConfig: () => buildAgentConfig(session),
      hooks: (hookCtx) => {
        const budget = session.childRun ? budgets()[session.childRun.budgetKind] : budgets().main
        return createRunHooks({
          sessionId: session.id,
          runId: hookCtx.runId,
          used: hookCtx.used,
          risk: (name, args) => session.riskOf(name, args),
          permissionMode: () => resolvePermissionMode(session.permissionSessionId),
          requestPermission: (req) => session.permissionRegistry.request(req, session.slot.getSignal()),
          budget,
          broadcast: broadcastWire,
          log,
          signal: () => session.slot.getSignal(),
          abortRun: (reason) => agent.abortRun(reason),
          onPlanTodos: (todos) => agent.appendPlanTodos(todos),
        })
      },
      log,
    })
    session.agent = agent
    return agent
  }

  // Delegate a run to a hidden child session (spec §4). Creates the child
  // session, records the delegation on the PARENT timeline as custom entries,
  // runs the child SessionAgent to completion while the parent yields its slot,
  // then records the result. The child's terminal STATUS survives to the tool
  // layer (ledger #6) so delegate can surface a failed/cancelled child.
  const delegate = async (
    parentSession: SessionState,
    prompt: string,
    opts: { agentType?: string; suggestedTools?: string[]; providerKey?: string; budgetKind: 'main' | 'sub' }
  ): Promise<DelegateResult & { messageId: string }> => {
    const def = resolveAgentDef(opts.agentType)
    const lookedUp = opts.providerKey ? cfg.getProvider(opts.providerKey) : undefined
    if (opts.providerKey && !lookedUp) {
      log.warn({ msg: 'providerKey not found, falling back to session provider', providerKey: opts.providerKey })
    }
    // The agent type may pin a model tier; otherwise inherit the provider's.
    // applyAgentModel preserves the provider's fallback chain.
    const resolvedProvider = applyAgentModel(lookedUp ?? parentSession.provider, def)

    const childSessionId = ulid()
    store.createSession(childSessionId, resolvedProvider, 'child')
    const childState = makeState(childSessionId, resolvedProvider, 'child')
    // A child inherits the parent's permission registry + governing session id
    // so a session-level 'full' grant is honored without re-prompting.
    childState.permissionRegistry = parentSession.permissionRegistry
    childState.permissionSessionId = parentSession.permissionSessionId
    childState.childRun = {
      agentDef: def,
      tools: opts.suggestedTools ?? allowlistForAgent(def),
      budgetKind: opts.budgetKind,
      artifacts: [],
    }
    sessions.set(childSessionId, childState)

    appendCustomEntry(parentSession.id, 'delegation', { childSessionId, agentDefId: def.id, prompt })
    log.info({ msg: 'child delegated', sessionId: parentSession.id, childSessionId, agentDefId: def.id })

    const childAgent = getOrCreateAgent(childState)
    // Cascade a parent cancel to the child, and yield the parent's slot while
    // the child runs so a full pool of delegating parents can't wedge.
    const parentSignal = parentSession.slot.getSignal()
    const onAbort = (): void => childAgent.cancel()
    parentSignal?.addEventListener('abort', onAbort, { once: true })
    let result: RunResult
    try {
      result = await parentSession.slot.yieldWhile(() => {
        childAgent.submitUserMessage(prompt)
        return childAgent.waitForCompletion()
      })
    } finally {
      parentSignal?.removeEventListener('abort', onAbort)
      // Free the child's in-memory state (its SessionAgent, coalesce timer, and
      // the sessions-map entry). The child's entries persist in the store and
      // nothing reads the retained live state after completion, so keeping it
      // would leak unboundedly under fan-out (CEO→leaders→subagents) workloads.
      // dispose() is safe whatever the outcome (completed/failed/cancelled).
      // childState (local) still backs the artifacts read below.
      childAgent.dispose()
      sessions.delete(childSessionId)
    }

    appendCustomEntry(parentSession.id, 'delegation_result', {
      childSessionId,
      status: result.status,
      summary: result.summary,
    })
    log.info({
      msg: 'child delegation finished',
      sessionId: parentSession.id,
      childSessionId,
      status: result.status,
    })
    return {
      messageId: childSessionId,
      status: result.status,
      summary: result.summary,
      artifacts: childState.childRun.artifacts,
    }
  }

  const getOrRehydrate = (sessionId: string): SessionState | undefined => {
    const live = sessions.get(sessionId)
    if (live) return live
    const stored = store.getSession(sessionId)
    if (!stored) return undefined
    // Children are ephemeral (created + run in a single process); only user
    // sessions are ever rehydrated after a restart.
    const state = makeState(sessionId, stored.providerSnapshot, 'user')
    store.updateSessionStatus(sessionId, 'active')
    sessions.set(sessionId, state)
    return state
  }

  // Keep the long-lived system session's provider current whenever a fresh
  // session is created/forked.
  const refreshSystemSessionProvider = (provider: ProviderInjection): void => {
    if (!store.getSession(SYSTEM_SESSION_ID)) return
    store.updateSessionProvider(SYSTEM_SESSION_ID, provider)
    const liveSystem = sessions.get(SYSTEM_SESSION_ID)
    if (liveSystem) liveSystem.provider = provider
  }

  // Mark any sessions left 'active' from a previous run as interrupted. Do not
  // broadcast here: at startup no renderer is connected. Live run state does not
  // survive a restart (entries persist, the SessionAgent does not).
  for (const s of store.getInterruptedSessions()) {
    store.updateSessionStatus(s.id, 'interrupted')
  }

  return {
    createSession(provider) {
      const sessionId = ulid()
      store.createSession(sessionId, provider)
      sessions.set(sessionId, makeState(sessionId, provider))
      broadcaster.broadcast('session.created', { sessionId, title: null, ts: Date.now() })
      log.info({ msg: 'session created', sessionId })
      refreshSystemSessionProvider(provider)
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
        sessions.set(SYSTEM_SESSION_ID, makeState(SYSTEM_SESSION_ID, from.provider))
        store.setSessionTitle(SYSTEM_SESSION_ID, 'Scheduled tasks')
        log.info({ msg: 'system session created', fromSessionId })
      }
      return SYSTEM_SESSION_ID
    },

    submitPrompt(sessionId, prompt, attachmentsArg, onComplete, options) {
      const session = getOrRehydrate(sessionId)
      if (!session) throw new Error(`session ${sessionId} not found`)
      const attachments = attachmentsArg ?? []

      // Composer choices arrive per submit; persist them so buildAgentConfig
      // (settings-driven in the entries model) picks them up for this run.
      if (
        options &&
        (options.cwd !== undefined || options.permissionMode || options.executionMode || options.agentType)
      ) {
        const prev = store.getSessionSettings(sessionId) ?? {}
        store.setSessionSettings(sessionId, {
          cwd: options.cwd ?? prev.cwd,
          permissionMode: options.permissionMode ?? prev.permissionMode,
          executionMode: options.executionMode ?? prev.executionMode,
          agentType: options.agentType ?? prev.agentType,
        })
      }

      const agent = getOrCreateAgent(session)
      const { entryRowId } = agent.submitUserMessage(prompt, attachments)
      // The submitted user entry's row id is the run's synchronous correlation
      // handle (the pi runId is minted asynchronously once the loop starts).
      const runId = String(entryRowId)

      // Post-submit bookkeeping only. Guarded: a throwing store here must not
      // escape to the dispatcher while the run is already streaming.
      try {
        store.updateSessionLastActive(sessionId)
        if (!store.getSession(sessionId)?.title) {
          const title = prompt.slice(0, 60)
          store.setSessionTitle(sessionId, title)
          broadcaster.broadcast('session.updated', { sessionId, title, lastActiveAt: Date.now(), ts: Date.now() })
        }
      } catch (err) {
        log.error({
          msg: 'post-submit bookkeeping failed',
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
      log.info({
        msg: 'conversation turn submitted',
        sessionId,
        entryRowId,
        agentType: options?.agentType ?? null,
        executionMode: options?.executionMode ?? null,
      })

      if (onComplete) {
        void agent.waitForCompletion().then((r) => {
          try {
            onComplete(r.status)
          } catch (err) {
            log.error({
              msg: 'submitPrompt onComplete threw',
              sessionId,
              err: err instanceof Error ? err.message : String(err),
            })
          }
        })
      }

      return { runId }
    },

    forkSession(sourceSessionId, upToRowId) {
      const source = getOrRehydrate(sourceSessionId)
      if (!source) throw new Error(`session not found: ${sourceSessionId}`)
      const sessionId = ulid()
      store.createSession(sessionId, source.provider)
      store.entries.copyUpTo(sourceSessionId, sessionId, upToRowId)
      sessions.set(sessionId, makeState(sessionId, source.provider))
      broadcaster.broadcast('session.created', { sessionId, title: null, ts: Date.now() })
      refreshSystemSessionProvider(source.provider)
      log.info({ msg: 'session forked', sourceSessionId, upToRowId, newSessionId: sessionId })
      return { sessionId }
    },

    getSessionEntries(sessionId, afterRowId) {
      return store.entries.list(sessionId, afterRowId)
    },

    cancelRun(sessionId) {
      log.info({ msg: 'run cancel requested', sessionId })
      const agent = sessions.get(sessionId)?.agent
      if (agent) agent.cancel()
      else log.warn({ msg: 'cancelRun: no live agent for session', sessionId })
    },

    resolvePermission(sessionId, actionId, decision) {
      sessions.get(sessionId)?.permissionRegistry.resolve(actionId, decision)
    },

    deleteSession(sessionId) {
      log.info({ msg: 'session deleted', sessionId })
      // Stop any in-flight run before dropping state so it can't append orphans.
      sessions.get(sessionId)?.agent?.cancel()
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
      // Persisting is all that's needed: buildAgentConfig resolves the run's
      // agent/cwd/permission/execution live from these settings each run.
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

    liveSessionIds() {
      return [...sessions.keys()]
    },
  }
}
