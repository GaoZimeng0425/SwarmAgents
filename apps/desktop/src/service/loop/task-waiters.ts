import { createLogger } from '@shared/logger'
import { ulid } from 'ulid'

import type { ConversationStore } from '../conversation/store'

const log = createLogger({ process: 'service' }).child({ component: 'task-waiters' })

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

const completionGoal = (taskId: string, status: string) =>
  `The task you were waiting on (${taskId}) finished with status "${status}". Continue your work toward your goal.`
const notFoundGoal = (taskId: string) =>
  `The task you were waiting on (${taskId}) could not be found (it may have been removed). Decide how to proceed toward your goal.`

export type TaskWaiterDeps = {
  store: ConversationStore
  /** Wake the waiting agent's resident actor by delivering a goal to its address. */
  deliver: (sessionId: string, address: string, goal: string) => void
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
  const { store, deliver } = deps

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
      const task = store.getTask(taskId)
      if (!task) {
        log.warn({ msg: 'wait_for_task on missing task; firing immediately', taskId, waiterAddress })
        safeDeliver(sessionId, waiterAddress, goal ?? notFoundGoal(taskId))
        return { id: null, firedImmediately: true }
      }
      if (TERMINAL.has(task.status)) {
        log.info({ msg: 'wait_for_task on already-terminal task; firing immediately', taskId, status: task.status })
        safeDeliver(sessionId, waiterAddress, goal ?? completionGoal(taskId, task.status))
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
      const all = store.listAllTaskWaiters()
      for (const w of all) {
        const task = store.getTask(w.taskId)
        if (!task || TERMINAL.has(task.status)) {
          const goal = w.goal ?? (task ? completionGoal(w.taskId, task.status) : notFoundGoal(w.taskId))
          log.info({ msg: 're-arm: waiter target already resolved; firing', id: w.id, taskId: w.taskId })
          safeDeliver(w.sessionId, w.waiterAddress, goal)
          store.deleteTaskWaiter(w.id)
        }
      }
    },
  }
}
