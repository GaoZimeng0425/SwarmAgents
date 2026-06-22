import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { DEFAULT_AGENT_DEF } from '@shared/agents/builtins'
import { createLogger } from '@shared/logger'
import type { AgentDefinition } from '@shared/types/agent'
import { deriveAllowlist } from '@shared/types/agent'
import { type BudgetConfig, defaultBudgetConfig } from '@shared/types/budgets'
import type { ProviderInjection } from '@shared/types/provider'
import type { Task, TaskEvent, TaskOptions, TaskResult, TaskStatus } from '@shared/types/task'
import type { PermissionDecision } from '@shared/types/ui'
import { ulid } from 'ulid'

import { createAgentRunner } from './agent-runner'
import { withAgentTypes } from './agents/prompt'
import type { AgentStore } from './agents/store'
import type { Broadcaster } from './broadcaster'
import type { ConversationStore } from './conversation-store'
import { createPermissionRegistry, type PermissionRegistry } from './permission-registry'
import { withSkills } from './skills/prompt'
import type { SkillStore } from './skills/store'
import { registerBuiltinTools } from './tools/builtins'
import { createToolRegistry, type ToolRegistry } from './tools/registry'

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
  // update_plan only — exclude spawn_sub_agent, whose child could mutate.
  'agent.update_plan',
]

type Session = {
  id: string
  provider: ProviderInjection
  permissionRegistry: PermissionRegistry
  messages: AgentMessage[]
  queue: Promise<void>
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
}

export type SessionManager = {
  createSession(provider: ProviderInjection): { sessionId: string }
  submitGoal(
    sessionId: string,
    goal: string,
    attachments?: import('@shared/types/task').Attachment[],
    agentDef?: AgentDefinition,
    onComplete?: (status: TaskStatus, error?: string) => void,
    options?: TaskOptions
  ): { taskId: string }
  resolvePermission(sessionId: string, actionId: string, decision: PermissionDecision): void
  cancelTask(sessionId: string, taskId: string): void
  endSession(sessionId: string): void
  deleteSession(sessionId: string): void
  renameSession(sessionId: string, title: string): void
  setSessionPinned(sessionId: string, pinned: boolean): void
  reorderSessions(orderedIds: string[]): void
  listSessions(): import('@shared/types/ui').SessionSummary[]
  getSessionTasks(sessionId: string): Task[]
  getUsageStats(rangeDays: number): import('@shared/types/usage').UsageStats
  /** @internal test hook */
  __ensureActorForTest?(sessionId: string, agentDefId: string, name?: string): import('@shared/types/actor').Actor
  /** @internal test hook */
  __sendMessageForTest?(
    sessionId: string,
    fromAddr: string | null,
    toAddr: string,
    payload: string,
    kind: 'send' | 'rpc'
  ): Promise<{ reply: string } | { delivered: true }>
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
    if (cfg.skillStore) systemPrompt = withSkills(systemPrompt, cfg.skillStore.list())
    if (cfg.agentStore) systemPrompt = withAgentTypes(systemPrompt, cfg.agentStore.list())
    return { ...def, systemPrompt }
  }

  // Read the user-configured per-task budgets at task-creation time; defaults
  // apply when no getter is wired (tests/scripts).
  const budgets = (): BudgetConfig => cfg.getBudgetConfig?.() ?? defaultBudgetConfig()

  let activeRunners = 0
  const waitQueue: Array<() => void> = []
  // Live runs, keyed by taskId, so cancelTask can abort a specific in-flight run.
  const runHandles = new Map<string, AbortController>()

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

  // Mark any sessions left 'active' from a previous run as interrupted.
  // Do not broadcast task.error here: at startup no renderer is connected,
  // and s.id is a session id, not a task id, which would produce spurious events.
  for (const s of store.getInterruptedSessions()) {
    store.updateSessionStatus(s.id, 'interrupted')
  }

  const makeEmit =
    (sessionId: string) =>
    (event: string, data: unknown): void => {
      const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
      const payload = obj ? { sessionId, ...obj } : data
      const taskId = obj?.taskId as string | undefined

      if (event === 'task.progress' && taskId && obj?.event) {
        store.appendTaskEvent(taskId, obj.event as TaskEvent)
      }
      if (event === 'task.error' && taskId && obj?.error) {
        store.appendTaskEvent(taskId, {
          kind: 'error',
          error: obj.error as Extract<TaskEvent, { kind: 'error' }>['error'],
          ts: Date.now(),
        })
      }
      if (event === 'task.plan' && taskId && Array.isArray(obj?.todos)) {
        const todos = obj.todos as import('@shared/types/task').PlanTodo[]
        store.saveTaskPlan(taskId, todos)
        log.debug({ msg: 'plan persisted', taskId, steps: todos.length })
      }
      broadcaster.broadcast(event, payload)
    }

  // Resolve-or-create an addressable identity. With a name, an existing actor in
  // the same session is reused (so `send('researcher-1', …)` keeps hitting the
  // same identity); without a name a fresh ULID address is minted each time.
  const ensureActor = (sessionId: string, agentDefId: string, name?: string): import('@shared/types/actor').Actor => {
    if (name) {
      const existing = store.getActorByName(sessionId, name)
      if (existing) return existing
    }
    const now = Date.now()
    const actor: import('@shared/types/actor').Actor = {
      address: ulid(),
      agentDefId,
      sessionId,
      name: name ?? null,
      state: null,
      lastTaskId: null,
      createdAt: now,
      updatedAt: now,
    }
    store.upsertActor(actor)
    log.info({ msg: 'actor created', sessionId, address: actor.address, agentDefId, name: name ?? null })
    return actor
  }

  // Resolve `to` as either a raw ULID address or a session-scoped readable name.
  const resolveAddress = (sessionId: string, to: string): import('@shared/types/actor').Actor | undefined =>
    store.getActor(to) ?? store.getActorByName(sessionId, to)

  // Run one activation of an addressable actor with `goal` as its input. Mirrors
  // spawnChild's run path: acquire a slot, build a runner, execute once, persist
  // the terminal status. Returns the run summary (the rpc reply).
  const activateActor = async (
    sessionId: string,
    actor: import('@shared/types/actor').Actor,
    goal: string
  ): Promise<string> => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)
    const def = cfg.agentStore?.get(actor.agentDefId) ?? DEFAULT_AGENT_DEF
    const taskId = ulid()
    const now = Date.now()
    const task: Task = {
      id: taskId,
      parentId: null,
      agentDefId: def.id,
      goal,
      status: 'pending',
      assignedWorkerId: null,
      toolAllowlist: deriveAllowlist(def.toolScope),
      budget: budgets().sub,
      used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
      history: [],
      attachments: [],
      result: null,
      createdAt: now,
      startedAt: null,
      endedAt: null,
    }
    store.saveTask(task, sessionId)
    store.upsertActor({ ...actor, lastTaskId: taskId, updatedAt: now })
    broadcaster.broadcast('task.created', { sessionId, taskId, goal, attachments: [], agentDefId: def.id, ts: now })
    log.info({ msg: 'actor activated', sessionId, address: actor.address, taskId, agentDefId: def.id })

    await acquireSlot()
    const abort = new AbortController()
    runHandles.set(taskId, abort)
    const runner = createAgentRunner({
      task,
      provider: def.model ? { ...session.provider, model: def.model } : session.provider,
      agentDefinition: withPrompt(def),
      sessionId,
      emit: makeEmit(sessionId),
      permissionRegistry: session.permissionRegistry,
      toolRegistry,
      initialMessages: [],
      signal: abort.signal,
      selfAddress: actor.address,
      sendMessage: (from, to, payload, kind) => sendMessage(sessionId, from, to, payload, kind),
      spawnChild: (pt, ng, st, pk, at) => spawnChild(sessionId, pt, ng, st, pk, at),
    })
    try {
      const { status, summary } = await runner.run()
      store.updateTaskStatus(taskId, status)
      return summary
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ msg: 'actor activation failed', address: actor.address, taskId, err: message })
      try {
        store.appendTaskEvent(taskId, {
          kind: 'error',
          error: { code: 'run_failed', message, tier: 'fatal' },
          ts: Date.now(),
        })
        store.updateTaskStatus(taskId, 'failed')
      } catch (persistErr) {
        log.error({ msg: 'failed to persist activation error', taskId, err: String(persistErr) })
      }
      return ''
    } finally {
      runHandles.delete(taskId)
      releaseSlot()
    }
  }

  const sendMessage = async (
    sessionId: string,
    fromAddr: string | null,
    toAddr: string,
    payload: string,
    kind: 'send' | 'rpc'
  ): Promise<{ reply: string } | { delivered: true }> => {
    const target = resolveAddress(sessionId, toAddr)
    const now = Date.now()
    const msgId = ulid()
    store.enqueueMessage({
      id: msgId,
      toAddr: target?.address ?? toAddr,
      fromAddr,
      kind,
      correlationId: kind === 'rpc' ? msgId : null,
      payload,
      consumed: false,
      retries: 0,
      dead: !target,
      ts: now,
    })
    if (!target) {
      log.warn({ msg: 'message to unknown address dead-lettered', sessionId, toAddr, kind })
      return kind === 'rpc' ? { reply: '' } : { delivered: true }
    }
    log.info({ msg: 'message sent', sessionId, fromAddr, toAddr: target.address, kind, correlationId: msgId })

    if (kind === 'rpc') {
      const reply = await activateActor(sessionId, target, payload)
      store.markConsumed(msgId)
      return { reply }
    }
    // fire-and-forget: activate without blocking; mark consumed when done.
    void activateActor(sessionId, target, payload)
      .then(() => store.markConsumed(msgId))
      .catch((err) => log.error({ msg: 'fire-and-forget activation rejected', msgId, err: String(err) }))
    return { delivered: true }
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
    // The agent type may pin a specific model; otherwise inherit the provider's.
    const baseProvider = lookedUp ?? session.provider
    const resolvedProvider = def.model ? { ...baseProvider, model: def.model } : baseProvider

    const childTaskId = ulid()
    const now = Date.now()
    const childTask: Task = {
      id: childTaskId,
      parentId: parentTaskId,
      agentDefId: def.id,
      goal: newGoal,
      status: 'pending',
      assignedWorkerId: null,
      toolAllowlist: suggestedTools ?? deriveAllowlist(def.toolScope),
      budget: budgets().sub,
      used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
      history: [],
      attachments: [],
      result: null,
      createdAt: now,
      startedAt: null,
      endedAt: null,
    }
    store.saveTask(childTask, sessionId)
    log.info({ msg: 'child spawned', sessionId, parentTaskId, childTaskId, agentDefId: def.id })

    // A child needs its own task.created so the renderer builds a real task
    // record; without it the child's later events arrive for an unknown taskId
    // and degrade into an "(unknown task)" stub. parentTaskId/agentDefId let the
    // UI group it as a distinct sub-agent block.
    broadcaster.broadcast('task.created', {
      sessionId,
      taskId: childTaskId,
      goal: newGoal,
      attachments: [],
      parentTaskId,
      agentDefId: def.id,
      ts: now,
    })
    broadcaster.broadcast('task.handoff.spawned', { sessionId, parentTaskId, childTaskId, ts: now })

    return new Promise<{ childTaskId: string; result: TaskResult }>((resolve) => {
      const startChild = async (): Promise<void> => {
        await acquireSlot()
        const abort = new AbortController()
        runHandles.set(childTaskId, abort)
        const runner = createAgentRunner({
          task: childTask,
          provider: resolvedProvider,
          agentDefinition: withPrompt(def),
          sessionId,
          emit: makeEmit(sessionId),
          permissionRegistry: session.permissionRegistry,
          toolRegistry,
          initialMessages: [],
          signal: abort.signal,
          spawnChild: (pt, ng, st, pk, at) => spawnChild(sessionId, pt, ng, st, pk, at),
        })
        try {
          const { status, summary } = await runner.run()
          // Persist the child's terminal status. Without this the child row stays
          // 'pending' forever (only submitGoal updated status before), so on
          // rehydrate the finished sub-agent reads as still-running and the chat
          // looks stuck executing.
          store.updateTaskStatus(childTaskId, status)
          resolve({ childTaskId, result: { summary, artifacts: [] } })
        } catch (err) {
          log.error({
            msg: 'spawnChild run failed',
            childTaskId,
            err: err instanceof Error ? err.message : String(err),
          })
          try {
            store.appendTaskEvent(childTaskId, {
              kind: 'error',
              error: { code: 'run_failed', message: err instanceof Error ? err.message : String(err), tier: 'fatal' },
              ts: Date.now(),
            })
          } catch (appendErr) {
            log.error({ msg: 'failed to persist child error event', childTaskId, err: String(appendErr) })
          }
          try {
            store.updateTaskStatus(childTaskId, 'failed')
          } catch (statusErr) {
            log.error({ msg: 'failed to mark child failed', childTaskId, err: String(statusErr) })
          }
          // Resolve (not reject) so the parent's spawn tool gets a result and continues.
          resolve({ childTaskId, result: { summary: '', artifacts: [] } })
        } finally {
          runHandles.delete(childTaskId)
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
      permissionRegistry: createPermissionRegistry(makeEmit(sessionId)),
      messages: store.getAgentSnapshot(sessionId),
      queue: Promise.resolve(),
    }
    store.updateSessionStatus(sessionId, 'active')
    sessions.set(sessionId, rehydrated)
    return rehydrated
  }

  return {
    createSession(provider) {
      const sessionId = ulid()
      store.createSession(sessionId, provider)
      const permissionRegistry = createPermissionRegistry(makeEmit(sessionId))
      sessions.set(sessionId, {
        id: sessionId,
        provider,
        permissionRegistry,
        messages: [],
        queue: Promise.resolve(),
      })
      broadcaster.broadcast('session.created', { sessionId, title: null, ts: Date.now() })
      log.info({ msg: 'session created', sessionId })
      return { sessionId }
    },

    submitGoal(sessionId, goal, attachmentsArg, agentDefArg, onComplete, options) {
      const session = getOrRehydrate(sessionId)
      if (!session) throw new Error(`session ${sessionId} not found`)

      const attachments = attachmentsArg ?? []
      // Resolve agent definition: explicit arg wins, then options.agentType lookup,
      // then DEFAULT_AGENT_DEF. Mirrors spawnChild's resolution logic.
      const resolvedByType = options?.agentType ? cfg.agentStore?.get(options.agentType) : undefined
      if (options?.agentType && !resolvedByType) {
        log.warn({ msg: 'agentType not found, falling back to default', agentType: options.agentType })
      }
      const agentDef = agentDefArg ?? resolvedByType ?? DEFAULT_AGENT_DEF

      const taskId = ulid()
      const now = Date.now()
      const isFirst = store.getSessionTasks(sessionId).length === 0
      // Plan mode forces the read-only tool set regardless of the agent's scope,
      // so the agent can investigate but not mutate while planning.
      const toolAllowlist =
        options?.executionMode === 'plan' ? PLAN_READONLY_ALLOWLIST : deriveAllowlist(agentDef.toolScope)
      const task: Task = {
        id: taskId,
        parentId: null,
        agentDefId: agentDef.id,
        goal,
        status: 'pending',
        assignedWorkerId: null,
        toolAllowlist,
        budget: budgets().main,
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
        attachments,
        result: null,
        createdAt: now,
        startedAt: null,
        endedAt: null,
        cwd: options?.cwd,
        permissionMode: options?.permissionMode,
        executionMode: options?.executionMode,
      }
      store.saveTask(task, sessionId)
      broadcaster.broadcast('task.created', { sessionId, taskId, goal, attachments, ts: now })
      store.updateSessionLastActive(sessionId)
      log.info({
        msg: 'goal submitted',
        sessionId,
        taskId,
        agentDefId: agentDef.id,
        cwd: options?.cwd ?? null,
        permissionMode: options?.permissionMode ?? 'ask',
        executionMode: options?.executionMode ?? 'goal',
      })

      if (isFirst) {
        const title = goal.slice(0, 60)
        store.setSessionTitle(sessionId, title)
        broadcaster.broadcast('session.updated', { sessionId, title, lastActiveAt: now, ts: now })
      }

      const runTurn = async (): Promise<void> => {
        await acquireSlot()
        const abort = new AbortController()
        runHandles.set(taskId, abort)
        const runner = createAgentRunner({
          task,
          provider: session.provider,
          agentDefinition: withPrompt(agentDef),
          sessionId,
          emit: makeEmit(sessionId),
          permissionRegistry: session.permissionRegistry,
          toolRegistry,
          initialMessages: session.messages,
          saveSnapshot: (messages, used, contextWindow) => {
            session.messages = messages
            store.saveAgentSnapshot(sessionId, messages)
            store.saveTaskUsage(taskId, used, contextWindow)
          },
          signal: abort.signal,
          spawnChild: (pt, ng, st, pk, at) => spawnChild(sessionId, pt, ng, st, pk, at),
        })
        try {
          const { status } = await runner.run()
          store.updateTaskStatus(taskId, status)
          onComplete?.(status)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.error({ msg: 'runTurn failed', taskId, err: message })
          try {
            store.appendTaskEvent(taskId, {
              kind: 'error',
              error: { code: 'run_failed', message, tier: 'fatal' },
              ts: Date.now(),
            })
          } catch (appendErr) {
            log.error({ msg: 'failed to persist error event', taskId, err: String(appendErr) })
          }
          try {
            store.updateTaskStatus(taskId, 'failed')
          } catch (statusErr) {
            log.error({ msg: 'failed to mark task failed', taskId, err: String(statusErr) })
          }
          onComplete?.('failed', message)
        } finally {
          runHandles.delete(taskId)
          releaseSlot()
        }
      }

      session.queue = session.queue.then(runTurn, runTurn)
      return { taskId }
    },

    resolvePermission(sessionId, actionId, decision) {
      sessions.get(sessionId)?.permissionRegistry.resolve(actionId, decision)
    },

    cancelTask(sessionId, taskId) {
      log.info({ msg: 'task cancel requested', sessionId, taskId })
      runHandles.get(taskId)?.abort()
    },

    endSession(sessionId) {
      log.info({ msg: 'session ended', sessionId })
      store.updateSessionStatus(sessionId, 'ended')
      sessions.delete(sessionId)
    },

    deleteSession(sessionId) {
      log.info({ msg: 'session deleted', sessionId })
      // Abort any in-flight runs for this session before dropping its rows.
      for (const t of store.getSessionTasks(sessionId)) runHandles.get(t.id)?.abort()
      sessions.delete(sessionId)
      store.deleteSession(sessionId)
    },

    renameSession(sessionId, title) {
      store.setSessionTitle(sessionId, title)
    },

    setSessionPinned(sessionId, pinned) {
      store.setSessionPinned(sessionId, pinned)
    },

    reorderSessions(orderedIds) {
      store.reorderSessions(orderedIds)
    },

    listSessions() {
      return store.listSessions()
    },

    getSessionTasks(sessionId) {
      return store.getSessionTasks(sessionId)
    },

    getUsageStats(rangeDays) {
      return store.getUsageStats(rangeDays)
    },

    // Test-only: exercise actor resolution without driving a full run.
    __ensureActorForTest(sessionId: string, agentDefId: string, name?: string) {
      return ensureActor(sessionId, agentDefId, name)
    },

    // Test-only: drive sendMessage directly.
    __sendMessageForTest(
      sessionId: string,
      fromAddr: string | null,
      toAddr: string,
      payload: string,
      kind: 'send' | 'rpc'
    ) {
      return sendMessage(sessionId, fromAddr, toAddr, payload, kind)
    },
  }
}
