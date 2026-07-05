import { z } from 'zod'

import type { UIEvent } from './ui'

export const taskStatusValues = [
  'pending',
  'planning',
  'dispatched',
  'running',
  'awaiting_user',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const

export const TaskStatusSchema = z.enum(taskStatusValues)
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const ResourceBudgetSchema = z.object({
  tokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
  usdCents: z.number().int().nonnegative(),
})
export type ResourceBudget = z.infer<typeof ResourceBudgetSchema>

export const emptyBudget = (): ResourceBudget => ({ tokens: 0, calls: 0, wallMs: 0, usdCents: 0 })

// Consumed resources extend the budget counters with prompt-cache breakdown.
// Kept separate from ResourceBudget so cache fields never leak into the budget
// *limits* config (which only caps tokens/calls/wallMs/usdCents). cacheRead is
// the cache-hit (read) token count, cacheWrite the cache-creation token count.
// Both are latest-turn snapshots, mirroring `tokens` (see replay.ts). Defaults
// keep legacy persisted rows (without the fields) parseable.
export const ConsumedResourcesSchema = ResourceBudgetSchema.extend({
  cacheRead: z.number().int().nonnegative().default(0),
  cacheWrite: z.number().int().nonnegative().default(0),
})
export type ConsumedResources = z.infer<typeof ConsumedResourcesSchema>

export const emptyUsed = (): ConsumedResources => ({
  tokens: 0,
  calls: 0,
  wallMs: 0,
  usdCents: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

// Per-task execution controls chosen in the composer. `permissionMode` 'full'
// bypasses every permission prompt; 'ask' keeps the default risk gate.
// `executionMode` 'plan' restricts the agent to read-only tools and asks it to
// produce a plan first; 'goal' executes autonomously.
export const PermissionModeSchema = z.enum(['ask', 'full'])
export type PermissionMode = z.infer<typeof PermissionModeSchema>
export const ExecutionModeSchema = z.enum(['goal', 'plan'])
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>

export const planStatusValues = ['pending', 'in_progress', 'completed'] as const
export const PlanTodoSchema = z.object({
  content: z.string(),
  status: z.enum(planStatusValues),
})
export type PlanTodo = z.infer<typeof PlanTodoSchema>
export type PlanStatus = (typeof planStatusValues)[number]

// One item in a Leader's delegation plan. The Leader declares this DAG via the
// set_delegation_plan tool; dispatch is prompt-driven (parallel within a wave,
// waves ordered by dependsOn). Recorded for audit + UI, not mechanically enforced.
export const DelegationItemSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  // Which sub-agent type to spawn for this item; omitted → default agent.
  ownerAgentType: z.string().optional(),
  // Sibling item ids that must finish before this item is unblocked. Empty (= no
  // deps) marks a first-wave item. Drives wave dispatch in the Leader's prompt.
  dependsOn: z.array(z.string().min(1)).default([]),
})
export type DelegationItem = z.infer<typeof DelegationItemSchema>

// Composer-supplied options threaded from the renderer to session-manager.
export const RunOptionsSchema = z.object({
  cwd: z.string().optional(),
  permissionMode: PermissionModeSchema.optional(),
  executionMode: ExecutionModeSchema.optional(),
  // Agent type id (from the agent store) to use for this top-level run.
  // Resolved in session-manager; unknown ids fall back to DEFAULT_AGENT_DEF.
  agentType: z.string().optional(),
})
export type RunOptions = z.infer<typeof RunOptionsSchema>
/** @deprecated Back-compat alias for the pre-run.* engine (removed in Task 3). */
export type TaskOptions = RunOptions

export const TaskEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('llm.message'),
    role: z.enum(['assistant', 'user', 'tool']),
    content: z.unknown(),
    ts: z.number(),
    seq: z.number().optional(),
  }),
  z.object({ kind: z.literal('reasoning'), content: z.string(), ts: z.number(), seq: z.number().optional() }),
  z.object({
    kind: z.literal('tool.call'),
    server: z.string(),
    tool: z.string(),
    args: z.unknown(),
    ts: z.number(),
    seq: z.number().optional(),
    // Correlates a tool.result with its tool.call. Absent on legacy rows; the
    // segment renderer falls back to FIFO pairing in that case. Required for
    // correct pairing when several tools run in parallel (result emit order is
    // completion order, not call order), so each card resolves to a terminal
    // state instead of one staying "running" forever.
    callId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('tool.result'),
    ok: z.boolean(),
    payload: z.unknown(),
    ts: z.number(),
    seq: z.number().optional(),
    callId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('permission'),
    actionId: z.string(),
    decision: z.enum(['grant', 'deny', 'skip']),
    ts: z.number(),
    seq: z.number().optional(),
  }),
  z.object({ kind: z.literal('handoff'), childTaskId: z.string(), ts: z.number(), seq: z.number().optional() }),
  z.object({
    kind: z.literal('error'),
    error: z.object({
      code: z.string(),
      message: z.string(),
      tier: z.enum(['transient', 'recoverable', 'fatal', 'gave_up']),
    }),
    ts: z.number(),
    seq: z.number().optional(),
  }),
])
export type TaskEvent = z.infer<typeof TaskEventSchema>

/** One row of a session's run-event stream (UIEvent-shaped; the renderer's replay source). */
export type RunEvent = {
  runId: string
  parentRunId: string | null
  seq: number
  ts: number
  event: UIEvent
}

export const ArtifactSchema = z.object({
  kind: z.enum(['file', 'note', 'image']),
  path: z.string().optional(),
  text: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})
export type Artifact = z.infer<typeof ArtifactSchema>

export const DelegateResultSchema = z.object({
  summary: z.string(),
  artifacts: z.array(ArtifactSchema),
  // Terminal disposition of a delegated child run, when known. Optional so
  // legacy rows (result-only) still parse.
  status: z.enum(['completed', 'failed', 'cancelled']).optional(),
})
export type DelegateResult = z.infer<typeof DelegateResultSchema>
/** @deprecated Back-compat alias for the pre-run.* engine (removed in Task 3). */
export type TaskResult = DelegateResult

export const AttachmentSchema = z.object({
  data: z.string(), // base64-encoded bytes (no data: prefix)
  mimeType: z.string(),
  name: z.string().optional(),
})
export type Attachment = z.infer<typeof AttachmentSchema>
