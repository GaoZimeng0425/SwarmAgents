/**
 * Events streamed from Main → Renderer over the preload bridge.
 *
 * These are derived from Supervisor events plus task-creation hooks. They are
 * deliberately a thinner, renderer-friendly view of the IPC types — the
 * Renderer should not need to know about MessagePort, Outbound discriminants,
 * etc. Each event carries a server-side timestamp so the UI can render a
 * linear timeline without needing its own clock.
 */
import type { Risk } from './ipc'
import type { TaskEvent, TaskResult } from './task'

export type UIEvent =
  | { kind: 'task.created'; taskId: string; goal: string; ts: number }
  | { kind: 'task.dispatched'; taskId: string; workerId: string; ts: number }
  | { kind: 'task.progress'; taskId: string; event: TaskEvent; ts: number }
  | {
      kind: 'task.tool_call'
      taskId: string
      workerId: string
      tool: string
      args: unknown
      ts: number
    }
  | {
      kind: 'task.permission_request'
      taskId: string
      workerId: string
      actionId: string
      risk: Risk
      summary: string
      payload: unknown
      ts: number
    }
  | { kind: 'task.complete'; taskId: string; summary: string; ts: number }
  | { kind: 'task.error'; taskId: string; error: unknown; ts: number }

export type PermissionDecision = 'grant' | 'deny' | 'skip'

export type SubmitGoalResult = { taskId: string }

/**
 * The shape exposed to the renderer via contextBridge as `window.swarm`.
 */
export type SwarmBridge = {
  submitGoal(goal: string): Promise<SubmitGoalResult>
  cancelTask(taskId: string): Promise<void>
  decidePermission(actionId: string, decision: PermissionDecision): Promise<void>
  subscribeEvents(cb: (event: UIEvent) => void): () => void
}

// Re-exported for renderer convenience without dragging task.ts types directly.
export type { TaskResult, TaskEvent }
