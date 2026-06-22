import { z } from 'zod'

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

// Composer-supplied options threaded from the renderer to session-manager.
export const TaskOptionsSchema = z.object({
  cwd: z.string().optional(),
  permissionMode: PermissionModeSchema.optional(),
  executionMode: ExecutionModeSchema.optional(),
})
export type TaskOptions = z.infer<typeof TaskOptionsSchema>

export const planStatusValues = ['pending', 'in_progress', 'completed'] as const
export const PlanTodoSchema = z.object({
  content: z.string(),
  status: z.enum(planStatusValues),
})
export type PlanTodo = z.infer<typeof PlanTodoSchema>
export type PlanStatus = (typeof planStatusValues)[number]

export const TaskEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('llm.message'),
    role: z.enum(['assistant', 'user', 'tool']),
    content: z.unknown(),
    ts: z.number(),
  }),
  z.object({ kind: z.literal('reasoning'), content: z.string(), ts: z.number() }),
  z.object({ kind: z.literal('tool.call'), server: z.string(), tool: z.string(), args: z.unknown(), ts: z.number() }),
  z.object({ kind: z.literal('tool.result'), ok: z.boolean(), payload: z.unknown(), ts: z.number() }),
  z.object({
    kind: z.literal('permission'),
    actionId: z.string(),
    decision: z.enum(['grant', 'deny', 'skip']),
    ts: z.number(),
  }),
  z.object({ kind: z.literal('handoff'), childTaskId: z.string(), ts: z.number() }),
  z.object({
    kind: z.literal('error'),
    error: z.object({
      code: z.string(),
      message: z.string(),
      tier: z.enum(['transient', 'recoverable', 'fatal', 'gave_up']),
    }),
    ts: z.number(),
  }),
])
export type TaskEvent = z.infer<typeof TaskEventSchema>

export const ArtifactSchema = z.object({
  kind: z.enum(['file', 'note', 'image']),
  path: z.string().optional(),
  text: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})
export type Artifact = z.infer<typeof ArtifactSchema>

export const TaskResultSchema = z.object({
  summary: z.string(),
  artifacts: z.array(ArtifactSchema),
})
export type TaskResult = z.infer<typeof TaskResultSchema>

export const AttachmentSchema = z.object({
  data: z.string(), // base64-encoded bytes (no data: prefix)
  mimeType: z.string(),
  name: z.string().optional(),
})
export type Attachment = z.infer<typeof AttachmentSchema>

export const TaskSchema = z.object({
  id: z.string().length(26),
  parentId: z.string().nullable(),
  agentDefId: z.string().default('default'),
  goal: z.string(),
  status: TaskStatusSchema,
  assignedWorkerId: z.string().nullable(),
  toolAllowlist: z.array(z.string()),
  budget: ResourceBudgetSchema,
  used: ConsumedResourcesSchema,
  history: z.array(TaskEventSchema),
  attachments: z.array(AttachmentSchema).default([]),
  plan: z.array(PlanTodoSchema).default([]),
  result: TaskResultSchema.nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  // Resolved model context window (tokens), persisted so the usage display
  // survives a restart. Set once the run starts; absent on legacy rows.
  contextWindow: z.number().int().positive().optional(),
  // Composer-chosen working directory; relative tool paths resolve against it
  // and shell runs there. Absent → the user's home directory.
  cwd: z.string().optional(),
  // Permission gate and execution mode for this task. Absent on legacy rows;
  // consumers default to 'ask' / 'goal'.
  permissionMode: PermissionModeSchema.optional(),
  executionMode: ExecutionModeSchema.optional(),
})
export type Task = z.infer<typeof TaskSchema>
