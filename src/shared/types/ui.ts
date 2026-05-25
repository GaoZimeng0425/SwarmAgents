/**
 * Events streamed from Main → Renderer over the preload bridge.
 *
 * These are derived from Supervisor events plus task-creation hooks. They are
 * deliberately a thinner, renderer-friendly view of the IPC types — the
 * Renderer should not need to know about MessagePort, Outbound discriminants,
 * etc. Each event carries a server-side timestamp so the UI can render a
 * linear timeline without needing its own clock.
 */
import type { ConfirmRequest, ConfirmResponse, Risk } from './ipc'
import type { ProviderId, ProvidersStateView } from './provider'
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

export type ProvidersSetResult =
  | { ok: true }
  | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type ProvidersTestResult =
  | { ok: true; latencyMs: number }
  | {
      ok: false
      code: 'no_key' | 'unauthorized' | 'rate_limited' | 'network' | 'unknown'
      message: string
    }

export type ProvidersBridge = {
  get(): Promise<ProvidersStateView>
  setKey(p: ProviderId, key: string): Promise<ProvidersSetResult>
  clearKey(p: ProviderId): Promise<ProvidersSetResult>
  setActive(p: ProviderId | null): Promise<ProvidersSetResult>
  setModel(p: ProviderId, model: string): Promise<ProvidersSetResult>
  test(p: ProviderId): Promise<ProvidersTestResult>
  onStateChanged(cb: (v: ProvidersStateView) => void): () => void
  onDecryptFailed(cb: () => void): () => void
}

/**
 * The shape exposed to the renderer via contextBridge as `window.swarm`.
 */
export type SwarmBridge = {
  submitGoal(goal: string): Promise<SubmitGoalResult>
  cancelTask(taskId: string): Promise<void>
  decidePermission(actionId: string, decision: PermissionDecision): Promise<void>
  subscribeEvents(cb: (event: UIEvent) => void): () => void
  /** Get the current system accent color (RRGGBBAA hex). Returns null on unsupported platforms. */
  getAccent(): Promise<string | null>
  /** Subscribe to accent-color changes. Returns an unsubscribe function. */
  onAccentChange(cb: (hex: string) => void): () => void
  showConfirm(req: ConfirmRequest): Promise<ConfirmResponse>
  /** Open the Settings window. Optional initialRoute selects which tab to land on. */
  openSettings(opts?: { initialRoute?: string }): Promise<void>
  providers: ProvidersBridge
}

// Re-exported for renderer convenience without dragging task.ts types directly.
export type { TaskResult, TaskEvent }
