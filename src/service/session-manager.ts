import { ulid } from 'ulid'
import { createLogger } from '@shared/logger'
import type { ProviderInjection } from '@shared/types/provider'
import type { AgentDefinition } from '@shared/types/agent'
import type { PermissionDecision } from '@shared/types/ui'
import type { Task, TaskEvent, TaskResult } from '@shared/types/task'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createAgentRunner } from './agent-runner'
import type { ConversationStore } from './conversation-store'
import { createPermissionRegistry, type PermissionRegistry } from './permission-registry'
import type { SseBroadcaster } from './sse'

const log = createLogger({ process: 'service' }).child({ component: 'session-manager' })

type Session = {
  id: string
  provider: ProviderInjection
  permissionRegistry: PermissionRegistry
  messages: AgentMessage[]
  queue: Promise<void>
}

type SessionManagerConfig = {
  store: ConversationStore
  broadcaster: SseBroadcaster
  maxConcurrent: number
  getProvider(key: string): ProviderInjection | undefined
}

export type SessionManager = {
  createSession(provider: ProviderInjection): { sessionId: string }
  submitGoal(sessionId: string, goal: string, agentDef?: AgentDefinition): { taskId: string }
  resolvePermission(sessionId: string, actionId: string, decision: PermissionDecision): void
  endSession(sessionId: string): void
  listSessions(): import('@shared/types/ui').SessionSummary[]
  getSessionTasks(sessionId: string): Task[]
}

const DEFAULT_AGENT_DEF: AgentDefinition = {
  id: 'default', name: 'Default Agent', systemPrompt: '',
  toolScope: 'all', maxIterations: 25,
}

export function createSessionManager(cfg: SessionManagerConfig): SessionManager {
  const { store, broadcaster } = cfg
  const sessions = new Map<string, Session>()

  let activeRunners = 0
  const waitQueue: Array<() => void> = []

  async function acquireSlot(): Promise<void> {
    if (activeRunners < cfg.maxConcurrent) {
      activeRunners++
      return
    }
    await new Promise<void>(resolve => waitQueue.push(resolve))
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

  const makeEmit = (sessionId: string) => (event: string, data: unknown): void => {
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
    providerKey?: string,
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
      id: childTaskId, parentId: parentTaskId, agentDefId: 'default',
      goal: newGoal, status: 'pending', assignedWorkerId: null,
      toolAllowlist: suggestedTools ?? ['peekaboo.*', 'web.*', 'fs.*'],
      budget: { tokens: 50_000, calls: 25, wallMs: 300_000, usdCents: 100 },
      used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
      history: [], result: null, createdAt: now, startedAt: null, endedAt: null,
    }
    store.saveTask(childTask, sessionId)

    broadcaster.broadcast('task.handoff.spawned', { sessionId, parentTaskId, childTaskId, ts: now })

    return new Promise<{ childTaskId: string; result: TaskResult }>((resolve) => {
      const startChild = async (): Promise<void> => {
        await acquireSlot()
        const runner = createAgentRunner({
          task: childTask, provider: resolvedProvider,
          agentDefinition: DEFAULT_AGENT_DEF, sessionId,
          emit: makeEmit(sessionId), permissionRegistry: session.permissionRegistry,
          initialMessages: [],
          spawnChild: (pt, ng, st, pk) => spawnChild(sessionId, pt, ng, st, pk),
        })
        try {
          const { summary } = await runner.run()
          resolve({ childTaskId, result: { summary, artifacts: [] } })
        } finally {
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
        id: sessionId, provider, permissionRegistry, messages: [], queue: Promise.resolve(),
      })
      broadcaster.broadcast('session.created', { sessionId, title: null, ts: Date.now() })
      return { sessionId }
    },

    submitGoal(sessionId, goal, agentDef = DEFAULT_AGENT_DEF) {
      const session = getOrRehydrate(sessionId)
      if (!session) throw new Error(`session ${sessionId} not found`)

      const taskId = ulid()
      const now = Date.now()
      const isFirst = store.getSessionTasks(sessionId).length === 0
      const task: Task = {
        id: taskId, parentId: null, agentDefId: agentDef.id,
        goal, status: 'pending', assignedWorkerId: null,
        toolAllowlist: ['peekaboo.*', 'web.*', 'fs.*'],
        budget: { tokens: 100_000, calls: 50, wallMs: 600_000, usdCents: 200 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [], result: null, createdAt: now, startedAt: null, endedAt: null,
      }
      store.saveTask(task, sessionId)
      broadcaster.broadcast('task.created', { sessionId, taskId, goal, ts: now })
      store.updateSessionLastActive(sessionId)

      if (isFirst) {
        const title = goal.slice(0, 60)
        store.setSessionTitle(sessionId, title)
        broadcaster.broadcast('session.updated', { sessionId, title, lastActiveAt: now, ts: now })
      }

      const runTurn = async (): Promise<void> => {
        await acquireSlot()
        const runner = createAgentRunner({
          task, provider: session.provider, agentDefinition: agentDef,
          sessionId, emit: makeEmit(sessionId), permissionRegistry: session.permissionRegistry,
          initialMessages: session.messages,
          spawnChild: (pt, ng, st, pk) => spawnChild(sessionId, pt, ng, st, pk),
        })
        try {
          const { status, messages } = await runner.run()
          if (messages) {
            session.messages = messages
            store.saveAgentSnapshot(sessionId, messages)
          }
          store.updateTaskStatus(taskId, status === 'completed' ? 'completed' : 'failed')
        } catch (err) {
          log.error({ msg: 'runTurn failed', taskId, err: err instanceof Error ? err.message : String(err) })
          try {
            store.updateTaskStatus(taskId, 'failed')
          } catch (statusErr) {
            log.error({ msg: 'failed to mark task failed', taskId, err: String(statusErr) })
          }
        } finally {
          releaseSlot()
        }
      }

      session.queue = session.queue.then(runTurn, runTurn)
      return { taskId }
    },

    resolvePermission(sessionId, actionId, decision) {
      sessions.get(sessionId)?.permissionRegistry.resolve(actionId, decision)
    },

    endSession(sessionId) {
      store.updateSessionStatus(sessionId, 'ended')
      sessions.delete(sessionId)
    },

    listSessions() {
      return store.listSessions()
    },

    getSessionTasks(sessionId) {
      return store.getSessionTasks(sessionId)
    },
  }
}
