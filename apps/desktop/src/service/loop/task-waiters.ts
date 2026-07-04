import { createLogger } from '@shared/logger'
import { ulid } from 'ulid'

import type { ConversationStore } from '../conversation/store'
import type { TerminalRegistry } from '../session/terminal-registry'

const log = createLogger({ process: 'service' }).child({ component: 'task-waiters' })

const completionGoal = (taskId: string, status: string) =>
  `The task you were waiting on (${taskId}) finished with status "${status}". Continue your work toward your goal.`

export type TaskWaiterDeps = {
  store: ConversationStore
  /** Wake the waiting agent's resident actor by delivering a goal to its address. */
  deliver: (sessionId: string, address: string, goal: string) => void
  /** Source of truth for "is this run terminal?" — replaces the pre-4b getTask lookup. */
  terminalRegistry: TerminalRegistry
}

export type TaskWaiterService = {
  register(input: { sessionId: string; waiterAddress: string; taskId: string; goal: string | null }): {
    id: string | null
    firedImmediately: boolean
  }
  onTaskTerminal(taskId: string, status: string): void
  start(): void
}

export function createTaskWaiterService(deps: TaskWaiterDeps): TaskWaiterService {
  const { store, deliver, terminalRegistry } = deps

  // Deliver without letting one bad target abort the rest of the sweep.
  const safeDeliver = (sessionId: string, address: string, goal: string) => {
    try {
      deliver(sessionId, address, goal)
    } catch (err) {
      log.error({
        msg: 'waiter deliver failed',
        sessionId,
        address,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    register({ sessionId, waiterAddress, taskId, goal }) {
      if (terminalRegistry.isTerminal(taskId)) {
        const status = terminalRegistry.getStatus(taskId) ?? 'completed'
        log.info({ msg: 'wait_for_task on already-terminal run; firing immediately', taskId, status })
        safeDeliver(sessionId, waiterAddress, goal ?? completionGoal(taskId, status))
        return { id: null, firedImmediately: true }
      }
      const id = ulid()
      store.saveTaskWaiter({ id, sessionId, waiterAddress, taskId, goal, createdAt: Date.now() })
      log.info({ msg: 'waiter registered', id, taskId, waiterAddress })
      return { id, firedImmediately: false }
    },

    onTaskTerminal(taskId, status) {
      const waiters = store.listTaskWaitersForTask(taskId)
      if (waiters.length === 0) return
      log.info({ msg: 'task terminal; waking waiters', taskId, status, count: waiters.length })
      for (const w of waiters) {
        safeDeliver(w.sessionId, w.waiterAddress, w.goal ?? completionGoal(taskId, status))
        store.deleteTaskWaiter(w.id)
      }
    },

    start() {
      for (const w of store.listAllTaskWaiters()) {
        if (terminalRegistry.isTerminal(w.taskId)) {
          const status = terminalRegistry.getStatus(w.taskId) ?? 'completed'
          log.info({ msg: 're-arm: waiter target already resolved; firing', id: w.id, taskId: w.taskId })
          safeDeliver(w.sessionId, w.waiterAddress, w.goal ?? completionGoal(w.taskId, status))
          store.deleteTaskWaiter(w.id)
        }
      }
    },
  }
}
