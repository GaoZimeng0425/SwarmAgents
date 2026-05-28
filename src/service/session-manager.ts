import { ulid } from 'ulid'
import type { ProviderInjection } from '@shared/types/provider'
import type { AgentDefinition } from '@shared/types/agent'
import type { PermissionDecision } from '@shared/types/ui'
import type { Task, TaskResult } from '@shared/types/task'
import { createAgentRunner } from './agent-runner'
import type { ConversationStore } from './conversation-store'
import { createPermissionRegistry, type PermissionRegistry } from './permission-registry'
import type { SseBroadcaster } from './sse'

type Session = {
  id: string
  provider: ProviderInjection
  permissionRegistry: PermissionRegistry
  runnerActive: boolean
}

type SessionManagerConfig = {
  store: ConversationStore
  broadcaster: SseBroadcaster
  maxConcurrent: number
}

export type SessionManager = {
  createSession(provider: ProviderInjection): { sessionId: string }
  submitGoal(sessionId: string, goal: string, agentDef?: AgentDefinition): { taskId: string }
  resolvePermission(sessionId: string, actionId: string, decision: PermissionDecision): void
  endSession(sessionId: string): void
}

const DEFAULT_AGENT_DEF: AgentDefinition = {
  id: 'default', name: 'Default Agent', systemPrompt: '',
  toolScope: 'all', maxIterations: 25,
}

export function createSessionManager(cfg: SessionManagerConfig): SessionManager {
  const { store, broadcaster } = cfg
  const sessions = new Map<string, Session>()

  // Mark any sessions left 'active' from a previous run as interrupted.
  for (const s of store.getInterruptedSessions()) {
    store.updateSessionStatus(s.id, 'interrupted')
    broadcaster.broadcast('task.error', {
      taskId: s.id,
      error: { code: 'service_restart', message: 'Agent Service restarted; session interrupted.', tier: 'fatal' },
      ts: Date.now(),
    })
  }

  const emit = (event: string, data: unknown) => broadcaster.broadcast(event, data)

  const spawnChild = async (
    sessionId: string,
    parentTaskId: string,
    newGoal: string,
    suggestedTools?: string[],
  ): Promise<{ childTaskId: string; result: TaskResult }> => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)

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

    broadcaster.broadcast('task.handoff.spawned', { parentTaskId, childTaskId, ts: now })

    return new Promise<{ childTaskId: string; result: TaskResult }>((resolve) => {
      const runner = createAgentRunner({
        task: childTask, provider: session.provider,
        agentDefinition: DEFAULT_AGENT_DEF, sessionId,
        emit, permissionRegistry: session.permissionRegistry,
        spawnChild: (pt, ng, st) => spawnChild(sessionId, pt, ng, st),
      })
      void runner.run().then(() => {
        resolve({ childTaskId, result: { summary: '', artifacts: [] } })
      })
    })
  }

  return {
    createSession(provider) {
      const sessionId = ulid()
      store.createSession(sessionId, provider)
      const permissionRegistry = createPermissionRegistry(emit)
      sessions.set(sessionId, { id: sessionId, provider, permissionRegistry, runnerActive: false })
      return { sessionId }
    },

    submitGoal(sessionId, goal, agentDef = DEFAULT_AGENT_DEF) {
      const session = sessions.get(sessionId)
      if (!session) throw new Error(`session ${sessionId} not found`)

      const taskId = ulid()
      const now = Date.now()
      const task: Task = {
        id: taskId, parentId: null, agentDefId: agentDef.id,
        goal, status: 'pending', assignedWorkerId: null,
        toolAllowlist: ['peekaboo.*', 'web.*', 'fs.*'],
        budget: { tokens: 100_000, calls: 50, wallMs: 600_000, usdCents: 200 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [], result: null, createdAt: now, startedAt: null, endedAt: null,
      }

      store.saveTask(task, sessionId)
      broadcaster.broadcast('task.created', { taskId, goal, ts: now })
      store.updateSessionLastActive(sessionId)

      const runner = createAgentRunner({
        task, provider: session.provider, agentDefinition: agentDef,
        sessionId, emit, permissionRegistry: session.permissionRegistry,
        spawnChild: (pt, ng, st) => spawnChild(sessionId, pt, ng, st),
      })

      session.runnerActive = true
      void runner.run().then(() => {
        session.runnerActive = false
        store.updateTaskStatus(taskId, 'completed')
      })

      return { taskId }
    },

    resolvePermission(sessionId, actionId, decision) {
      sessions.get(sessionId)?.permissionRegistry.resolve(actionId, decision)
    },

    endSession(sessionId) {
      store.updateSessionStatus(sessionId, 'ended')
      sessions.delete(sessionId)
    },
  }
}
