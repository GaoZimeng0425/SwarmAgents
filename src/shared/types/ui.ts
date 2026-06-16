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
import type { McpMutationResult, McpServerConfig, McpServerStatus, McpToolOverride } from './mcp'
import type { ApiStyle, ModelThinkingLevel, ProviderId, ProvidersStateView } from './provider'
import type { Skill, SkillMutationResult } from './skill'
import type { Attachment, PlanTodo, ResourceBudget, TaskEvent, TaskResult } from './task'

export type UIEvent =
  | { kind: 'task.created'; sessionId: string; taskId: string; goal: string; attachments?: Attachment[]; ts: number }
  | { kind: 'task.dispatched'; sessionId: string; taskId: string; workerId: string; ts: number }
  | { kind: 'task.progress'; sessionId: string; taskId: string; event: TaskEvent; ts: number }
  | {
      kind: 'task.tool_call'
      sessionId: string
      taskId: string
      workerId: string
      tool: string
      args: unknown
      ts: number
    }
  | {
      kind: 'task.permission_request'
      sessionId: string
      taskId: string
      workerId: string
      actionId: string
      risk: Risk
      summary: string
      payload: unknown
      ts: number
    }
  | {
      kind: 'task.ask'
      sessionId: string
      taskId: string
      askId: string
      question: string
      options: { label: string; value?: string }[]
      mode: 'single' | 'multi'
      ts: number
    }
  | { kind: 'task.complete'; sessionId: string; taskId: string; summary: string; ts: number }
  | { kind: 'task.error'; sessionId: string; taskId: string; error: unknown; ts: number }
  | {
      kind: 'task.usage'
      sessionId: string
      taskId: string
      used: ResourceBudget
      /** Latest turn's context occupancy and the model's context-window size (for the composer ring). */
      contextTokens?: number
      contextWindow?: number
      ts: number
    }
  | { kind: 'task.plan'; sessionId: string; taskId: string; todos: PlanTodo[]; ts: number }
  | { kind: 'task.handoff.spawned'; sessionId: string; parentTaskId: string; childTaskId: string; ts: number }
  | {
      kind: 'task.handoff.completed'
      sessionId: string
      parentTaskId: string
      childTaskId: string
      childSummary: string
      ts: number
    }
  | { kind: 'session.created'; sessionId: string; title: string | null; ts: number }
  | { kind: 'session.updated'; sessionId: string; title: string | null; lastActiveAt: number; ts: number }

export type SessionSummary = {
  id: string
  title: string | null
  status: 'active' | 'interrupted' | 'ended'
  lastActiveAt: number
  taskCount: number
  pinned: boolean
}

export type PermissionDecision = 'grant' | 'deny' | 'skip'

export type SubmitGoalResult = { taskId: string }

export type ProvidersSetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type ProvidersTestResult =
  | { ok: true; latencyMs: number; url: string }
  | {
      ok: false
      code: 'no_key' | 'unauthorized' | 'rate_limited' | 'network' | 'unknown'
      message: string
      url?: string
    }

export type ProvidersBridge = {
  get(): Promise<ProvidersStateView>
  setKey(p: ProviderId, key: string): Promise<ProvidersSetResult>
  clearKey(p: ProviderId): Promise<ProvidersSetResult>
  setActive(p: ProviderId | null): Promise<ProvidersSetResult>
  setModel(p: ProviderId, model: string): Promise<ProvidersSetResult>
  /** Pass empty string or null to clear. */
  setBaseUrl(p: ProviderId, baseUrl: string | null): Promise<ProvidersSetResult>
  addCustomModel(p: ProviderId, model: string): Promise<ProvidersSetResult>
  removeCustomModel(p: ProviderId, model: string): Promise<ProvidersSetResult>
  /** Set the wire-format style for the `custom` slot. */
  setApiStyle(p: ProviderId, style: ApiStyle): Promise<ProvidersSetResult>
  /** Set the reasoning depth for a provider's model. */
  setThinkingLevel(p: ProviderId, level: ModelThinkingLevel): Promise<ProvidersSetResult>
  test(p: ProviderId): Promise<ProvidersTestResult>
  onStateChanged(cb: (v: ProvidersStateView) => void): () => void
  onDecryptFailed(cb: () => void): () => void
}

export type McpBridge = {
  list(): Promise<McpServerConfig[]>
  add(input: Omit<McpServerConfig, 'id'>): Promise<McpMutationResult & { id?: string }>
  update(id: string, patch: Partial<Omit<McpServerConfig, 'id'>>): Promise<McpMutationResult>
  remove(id: string): Promise<McpMutationResult>
  setEnabled(id: string, enabled: boolean): Promise<McpMutationResult>
  setToolOverride(id: string, toolName: string, override: McpToolOverride | null): Promise<McpMutationResult>
  getStatus(): Promise<McpServerStatus[]>
  onConfigChanged(cb: (configs: McpServerConfig[]) => void): () => void
  onStatus(cb: (statuses: McpServerStatus[]) => void): () => void
}

export type SkillBridge = {
  list(): Promise<Skill[]>
  save(skill: Skill): Promise<SkillMutationResult>
  remove(name: string): Promise<SkillMutationResult>
}

/** Status of a macOS TCC permission. 'unsupported' on non-macOS platforms. */
export type MacPermissionState = 'granted' | 'denied' | 'not-determined' | 'unsupported'

/** macOS permissions the peekaboo screen tools depend on. */
export type MacPermissions = {
  screenRecording: MacPermissionState
  accessibility: MacPermissionState
}

/**
 * The shape exposed to the renderer via contextBridge as `window.swarm`.
 */
export type SwarmBridge = {
  submitGoal(sessionId: string, goal: string, attachments?: Attachment[]): Promise<SubmitGoalResult>
  cancelTask(sessionId: string, taskId: string): Promise<void>
  decidePermission(sessionId: string, actionId: string, decision: PermissionDecision): Promise<void>
  respondAsk(sessionId: string, askId: string, answer: string): Promise<void>
  sessions: {
    list(): Promise<SessionSummary[]>
    create(): Promise<{ sessionId: string }>
    getTasks(sessionId: string): Promise<import('./task').Task[]>
    delete(sessionId: string): Promise<void>
    rename(sessionId: string, title: string): Promise<void>
    setPinned(sessionId: string, pinned: boolean): Promise<void>
  }
  subscribeEvents(cb: (event: UIEvent) => void): () => void
  /** Get the current system accent color (RRGGBBAA hex). Returns null on unsupported platforms. */
  getAccent(): Promise<string | null>
  /** Subscribe to accent-color changes. Returns an unsubscribe function. */
  onAccentChange(cb: (hex: string) => void): () => void
  showConfirm(req: ConfirmRequest): Promise<ConfirmResponse>
  /** Open the Settings window. Optional initialRoute selects which tab to land on. */
  openSettings(opts?: { initialRoute?: string }): Promise<void>
  /** Current macOS screen-recording / accessibility permission status. */
  getMacPermissions(): Promise<MacPermissions>
  /** Open the relevant macOS Privacy & Security settings pane. No-op off macOS. */
  openPrivacySettings(pane: 'screen' | 'accessibility'): Promise<void>
  /** Read a local image file as base64 for inline preview. Returns null if missing or not an image. */
  readImageFile(path: string): Promise<{ mimeType: string; data: string } | null>
  /** Open a local file with the OS default application. */
  openPath(path: string): Promise<void>
  providers: ProvidersBridge
  mcp: McpBridge
  skills: SkillBridge
}

// Re-exported for renderer convenience without dragging task.ts types directly.
export type { TaskEvent, TaskResult }
