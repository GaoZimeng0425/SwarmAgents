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

export const planStatusValues = ['pending', 'in_progress', 'completed'] as const
export const PlanTodoSchema = z.object({
  content: z.string(),
  status: z.enum(planStatusValues),
})
export type PlanTodo = z.infer<typeof PlanTodoSchema>
export type PlanStatus = (typeof planStatusValues)[number]

// A single machine-checkable "done" condition for an acceptance criterion.
//   command     — passes when the shell command exits with expectExitCode
//                  (default 0) and, when set, stdout contains expectStdout.
//   file_exists  — passes when the path exists (relative to the task cwd).
export const ExecutableCheckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    command: z.string().min(1),
    cwd: z.string().optional(),
    expectExitCode: z.number().int().optional(),
    expectStdout: z.string().optional(),
  }),
  z.object({
    kind: z.literal('file_exists'),
    path: z.string().min(1),
  }),
])
export type ExecutableCheck = z.infer<typeof ExecutableCheckSchema>

// One acceptance criterion. A `check` present ⇒ verified deterministically;
// absent ⇒ judged by the LLM verifier against the task summary.
export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  check: ExecutableCheckSchema.optional(),
})
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>

export const VerificationResultSchema = z.object({
  criterionId: z.string(),
  pass: z.boolean(),
  detail: z.string(),
})
export type VerificationResult = z.infer<typeof VerificationResultSchema>

// One verify round's outcome — persisted as an audit trail and surfaced to the UI.
export const VerificationRoundSchema = z.object({
  round: z.number().int().nonnegative(),
  verdict: z.enum(['pass', 'fail']),
  results: z.array(VerificationResultSchema),
  gaps: z.array(z.string()),
  ts: z.number().int(),
})
export type VerificationRound = z.infer<typeof VerificationRoundSchema>

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
  // Per-item done-conditions; passed down to the spawned sub-agent as its contract.
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).optional(),
})
export type DelegationItem = z.infer<typeof DelegationItemSchema>

// Extra contract passed down a delegation edge via spawnChild: the child's
// acceptance criteria (skips its Phase A when supplied) and whether it runs the
// verify loop (0 = single-shot leaf).
export type SpawnChildOptions = {
  acceptanceCriteria?: AcceptanceCriterion[]
  maxVerifyRounds?: number
}

// Composer-supplied options threaded from the renderer to session-manager.
export const TaskOptionsSchema = z.object({
  cwd: z.string().optional(),
  permissionMode: PermissionModeSchema.optional(),
  executionMode: ExecutionModeSchema.optional(),
  // Agent type id (from the agent store) to use for this top-level task.
  // Resolved in session-manager; unknown ids fall back to DEFAULT_AGENT_DEF.
  agentType: z.string().optional(),
  // Caller-supplied acceptance criteria; when present the agent skips Phase A
  // (criteria derivation) and the verify gate uses these directly.
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).optional(),
})
export type TaskOptions = z.infer<typeof TaskOptionsSchema>

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
  // Checkable done-conditions for this task. Derived by the agent in Phase A or
  // supplied by the caller; drives the verify gate.
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).optional(),
  // Per-round verify audit trail (UI + logs).
  verifications: z.array(VerificationRoundSchema).optional(),
  // Leader-authored delegation DAG (set_delegation_plan tool). Audit + UI only.
  delegationPlan: z.array(DelegationItemSchema).optional(),
})
export type Task = z.infer<typeof TaskSchema>
