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

export const TaskSchema = z.object({
  id: z.string().length(26),
  parentId: z.string().nullable(),
  agentDefId: z.string().default('default'),
  goal: z.string(),
  status: TaskStatusSchema,
  assignedWorkerId: z.string().nullable(),
  toolAllowlist: z.array(z.string()),
  budget: ResourceBudgetSchema,
  used: ResourceBudgetSchema,
  history: z.array(TaskEventSchema),
  result: TaskResultSchema.nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
})
export type Task = z.infer<typeof TaskSchema>
