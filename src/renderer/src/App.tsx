import { useCallback, useEffect, useReducer } from 'react'

import type { PermissionDecision, UIEvent } from '../../shared/types/ui'

import PermissionSheet, { type PermissionPrompt } from './components/PermissionSheet'
import TaskInput from './components/TaskInput'
import TaskList, { type TaskRecord, type TaskStatus } from './components/TaskList'
import TitleBar from './components/TitleBar'

type State = {
  tasks: Record<string, TaskRecord>
  order: string[] // most recent first
  permissionQueue: PermissionPrompt[]
}

type Action = { kind: 'event'; event: UIEvent } | { kind: 'permission_decided'; actionId: string }

function setStatus(task: TaskRecord, status: TaskStatus): TaskRecord {
  return { ...task, status }
}

function reducer(state: State, action: Action): State {
  if (action.kind === 'permission_decided') {
    return {
      ...state,
      permissionQueue: state.permissionQueue.filter((p) => p.actionId !== action.actionId),
    }
  }

  const e = action.event
  const taskId = 'taskId' in e ? e.taskId : null
  if (!taskId) return state

  const existing = state.tasks[taskId]

  // task.created — start a new record
  if (e.kind === 'task.created') {
    const record: TaskRecord = {
      id: e.taskId,
      goal: e.goal,
      status: 'pending',
      workerId: null,
      summary: null,
      startedAt: e.ts,
      events: [e],
    }
    return {
      ...state,
      tasks: { ...state.tasks, [e.taskId]: record },
      order: [e.taskId, ...state.order.filter((id) => id !== e.taskId)],
    }
  }

  // For every other event, append to the existing task's event list.
  if (!existing) {
    const stub: TaskRecord = {
      id: taskId,
      goal: '(unknown task)',
      status: 'running',
      workerId: null,
      summary: null,
      startedAt: e.ts,
      events: [e],
    }
    return {
      ...state,
      tasks: { ...state.tasks, [taskId]: stub },
      order: [taskId, ...state.order],
    }
  }

  let updated: TaskRecord = { ...existing, events: [...existing.events, e] }

  switch (e.kind) {
    case 'task.dispatched':
      updated = { ...updated, status: 'running', workerId: e.workerId }
      break
    case 'task.complete':
      updated = setStatus({ ...updated, summary: e.summary }, 'completed')
      break
    case 'task.error':
      updated = setStatus(updated, 'failed')
      break
    case 'task.permission_request':
      updated = setStatus(updated, 'awaiting_user')
      break
    default:
      break
  }

  let nextPermissionQueue = state.permissionQueue
  if (e.kind === 'task.permission_request') {
    if (!state.permissionQueue.some((p) => p.actionId === e.actionId)) {
      const prompt: PermissionPrompt = {
        actionId: e.actionId,
        taskId: e.taskId,
        workerId: e.workerId,
        risk: e.risk,
        summary: e.summary,
        payload: e.payload,
      }
      nextPermissionQueue = [...state.permissionQueue, prompt]
    }
  }

  return {
    ...state,
    tasks: { ...state.tasks, [taskId]: updated },
    permissionQueue: nextPermissionQueue,
  }
}

const initialState: State = { tasks: {}, order: [], permissionQueue: [] }

function App(): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState)

  useEffect(() => {
    const unsub = window.swarm.subscribeEvents((event) => dispatch({ kind: 'event', event }))
    return unsub
  }, [])

  const submit = useCallback(async (goal: string): Promise<void> => {
    try {
      await window.swarm.submitGoal(goal)
    } catch (err) {
      console.error('submitGoal failed', err)
    }
  }, [])

  const onPermissionDecide = useCallback(
    async (actionId: string, decision: PermissionDecision): Promise<void> => {
      try {
        await window.swarm.decidePermission(actionId, decision)
      } finally {
        dispatch({ kind: 'permission_decided', actionId })
      }
    },
    [],
  )

  const tasksInOrder = state.order
    .map((id) => state.tasks[id])
    .filter((t): t is TaskRecord => Boolean(t))

  const activePrompt = state.permissionQueue[0] ?? null

  return (
    <>
      <TitleBar />
      <TaskInput onSubmit={submit} />
      <TaskList tasks={tasksInOrder} />
      <PermissionSheet prompt={activePrompt} onDecide={onPermissionDecide} />
    </>
  )
}

export default App
