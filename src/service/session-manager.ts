import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { DEFAULT_SYSTEM_PROMPT } from '@shared/agents/default-prompt'
import { createLogger } from '@shared/logger'
import type { AgentDefinition } from '@shared/types/agent'
import { deriveAllowlist } from '@shared/types/agent'
import type { ProviderInjection } from '@shared/types/provider'
import type { Task, TaskEvent, TaskResult } from '@shared/types/task'
import type { PermissionDecision } from '@shared/types/ui'
import { ulid } from 'ulid'

import { createAgentRunner } from './agent-runner'
import { type AskRegistry, createAskRegistry } from './ask-registry'
import type { Broadcaster } from './broadcaster'
import type { ConversationStore } from './conversation-store'
import { createPermissionRegistry, type PermissionRegistry } from './permission-registry'
import { withSkills } from './skills/prompt'
import type { SkillStore } from './skills/store'
import { registerBuiltinTools } from './tools/builtins'
import { createToolRegistry, type ToolRegistry } from './tools/registry'

const log = createLogger({ process: 'service' }).child({ component: 'session-manager' })

type Session = {
  id: string
  provider: ProviderInjection
  permissionRegistry: PermissionRegistry
  askRegistry: AskRegistry
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
}

export type SessionManager = {
  createSession(provider: ProviderInjection): { sessionId: string }
  submitGoal(
    sessionId: string,
    goal: string,
    attachments?: import('@shared/types/task').Attachment[],
    agentDef?: AgentDefinition
  ): { taskId: string }
  resolvePermission(sessionId: string, actionId: string, decision: PermissionDecision): void
  resolveAsk(sessionId: string, askId: string, answer: string): void
  cancelTask(sessionId: string, taskId: string): void
  endSession(sessionId: string): void
  deleteSession(sessionId: string): void
  renameSession(sessionId: string, title: string): void
  setSessionPinned(sessionId: string, pinned: boolean): void
  listSessions(): import('@shared/types/ui').SessionSummary[]
  getSessionTasks(sessionId: string): Task[]
}

const DEFAULT_AGENT_DEF: AgentDefinition = {
  id: 'default',
  name: 'Default Agent',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  toolScope: 'all',
  maxIterations: 25,
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

  // Inject the available-skills list into the agent's system prompt at task
  // time, so newly-added skills appear without restarting.
  const withSkillPrompt = (def: AgentDefinition): AgentDefinition =>
    cfg.skillStore ? { ...def, systemPrompt: withSkills(def.systemPrompt, cfg.skillStore.list()) } : def

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

  const historyByTask = new Map<string, TaskEvent[]>()

  const makeEmit =
    (sessionId: string) =>
    (event: string, data: unknown): void => {
      const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
      const payload = obj ? { sessionId, ...obj } : data

      const taskId = obj?.taskId as string | undefined
      if (event === 'task.progress' && taskId && obj?.event) {
        const buf = historyByTask.get(taskId) ?? []
        buf.push(obj.event as TaskEvent)
        historyByTask.set(taskId, buf)
      }
      if ((event === 'task.complete' || event === 'task.error') && taskId) {
        store.saveTaskHistory(taskId, historyByTask.get(taskId) ?? [])
        historyByTask.delete(taskId)
      }
      broadcaster.broadcast(event, payload)
    }

  const spawnChild = async (
    sessionId: string,
    parentTaskId: string,
    newGoal: string,
    suggestedTools?: string[],
    providerKey?: string
  ): Promise<{ childTaskId: string; result: TaskResult }> => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)

    const lookedUp = providerKey ? cfg.getProvider(providerKey) : undefined
    if (providerKey && !lookedUp) {
      log.warn({ msg: 'providerKey not found, falling back to session provider', providerKey })
    }
    const resolvedProvider = lookedUp ?? session.provider

    const childTaskId = ulid()
    const now = Date.now()
    const childTask: Task = {
      id: childTaskId,
      parentId: parentTaskId,
      agentDefId: 'default',
      goal: newGoal,
      status: 'pending',
      assignedWorkerId: null,
      toolAllowlist: suggestedTools ?? ['peekaboo.*', 'agent.*'],
      budget: { tokens: 50_000, calls: 25, wallMs: 300_000, usdCents: 100 },
      used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
      history: [],
      attachments: [],
      result: null,
      createdAt: now,
      startedAt: null,
      endedAt: null,
    }
    store.saveTask(childTask, sessionId)

    broadcaster.broadcast('task.handoff.spawned', { sessionId, parentTaskId, childTaskId, ts: now })

    return new Promise<{ childTaskId: string; result: TaskResult }>((resolve) => {
      const startChild = async (): Promise<void> => {
        await acquireSlot()
        const abort = new AbortController()
        runHandles.set(childTaskId, abort)
        const runner = createAgentRunner({
          task: childTask,
          provider: resolvedProvider,
          agentDefinition: withSkillPrompt(DEFAULT_AGENT_DEF),
          sessionId,
          emit: makeEmit(sessionId),
          permissionRegistry: session.permissionRegistry,
          askRegistry: session.askRegistry,
          toolRegistry,
          initialMessages: [],
          signal: abort.signal,
          spawnChild: (pt, ng, st, pk) => spawnChild(sessionId, pt, ng, st, pk),
        })
        try {
          const { summary } = await runner.run()
          resolve({ childTaskId, result: { summary, artifacts: [] } })
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
      askRegistry: createAskRegistry(makeEmit(sessionId)),
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
      const askRegistry = createAskRegistry(makeEmit(sessionId))
      sessions.set(sessionId, {
        id: sessionId,
        provider,
        permissionRegistry,
        askRegistry,
        messages: [],
        queue: Promise.resolve(),
      })
      broadcaster.broadcast('session.created', { sessionId, title: null, ts: Date.now() })
      return { sessionId }
    },

    submitGoal(sessionId, goal, attachments = [], agentDef = DEFAULT_AGENT_DEF) {
      const session = getOrRehydrate(sessionId)
      if (!session) throw new Error(`session ${sessionId} not found`)

      const taskId = ulid()
      const now = Date.now()
      const isFirst = store.getSessionTasks(sessionId).length === 0
      const task: Task = {
        id: taskId,
        parentId: null,
        agentDefId: agentDef.id,
        goal,
        status: 'pending',
        assignedWorkerId: null,
        toolAllowlist: deriveAllowlist(agentDef.toolScope),
        budget: { tokens: 100_000, calls: 50, wallMs: 600_000, usdCents: 200 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
        attachments,
        result: null,
        createdAt: now,
        startedAt: null,
        endedAt: null,
      }
      store.saveTask(task, sessionId)
      broadcaster.broadcast('task.created', { sessionId, taskId, goal, attachments, ts: now })
      store.updateSessionLastActive(sessionId)

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
          agentDefinition: withSkillPrompt(agentDef),
          sessionId,
          emit: makeEmit(sessionId),
          permissionRegistry: session.permissionRegistry,
          askRegistry: session.askRegistry,
          toolRegistry,
          initialMessages: session.messages,
          signal: abort.signal,
          spawnChild: (pt, ng, st, pk) => spawnChild(sessionId, pt, ng, st, pk),
        })
        try {
          const { status, messages, used } = await runner.run()
          if (messages) {
            session.messages = messages
            store.saveAgentSnapshot(sessionId, messages)
          }
          if (used) store.saveTaskUsage(taskId, used)
          store.updateTaskStatus(taskId, status)
        } catch (err) {
          log.error({ msg: 'runTurn failed', taskId, err: err instanceof Error ? err.message : String(err) })
          try {
            store.updateTaskStatus(taskId, 'failed')
          } catch (statusErr) {
            log.error({ msg: 'failed to mark task failed', taskId, err: String(statusErr) })
          }
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

    resolveAsk(sessionId, askId, answer) {
      sessions.get(sessionId)?.askRegistry.resolve(askId, answer)
    },

    cancelTask(sessionId, taskId) {
      runHandles.get(taskId)?.abort()
      // Unblock any tool waiting on a human choice so the aborted run can settle.
      sessions.get(sessionId)?.askRegistry.cancelAll('Cancelled by user.')
    },

    endSession(sessionId) {
      store.updateSessionStatus(sessionId, 'ended')
      sessions.delete(sessionId)
    },

    deleteSession(sessionId) {
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

    listSessions() {
      return store.listSessions()
    },

    getSessionTasks(sessionId) {
      return store.getSessionTasks(sessionId)
    },
  }
}
