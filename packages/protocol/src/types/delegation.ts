import { z } from 'zod'

import { ArtifactSchema } from './artifact'

export const planStatusValues = ['pending', 'in_progress', 'completed'] as const
export const PlanTodoSchema = z.object({
  content: z.string(),
  status: z.enum(planStatusValues),
})
export type PlanTodo = z.infer<typeof PlanTodoSchema>
export type PlanStatus = (typeof planStatusValues)[number]

export const delegationItemStatusValues = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const
export const DelegationItemStatusSchema = z.enum(delegationItemStatusValues)
export type DelegationItemStatus = z.infer<typeof DelegationItemStatusSchema>

// One item in a Leader's delegation plan. The Leader declares this DAG via the
// set_delegation_plan tool; dispatch is prompt-driven (parallel within a wave,
// waves ordered by dependsOn). Recorded for audit + UI, not mechanically enforced.
export const DelegationItemSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  // Which sub-agent type to spawn for this item; omitted → default agent.
  ownerAgentType: z.string().optional(),
  // Sibling item ids that must finish before this item is unblocked. Empty (= no
  // deps) marks a first-wave item. Drives wave dispatch in the Leader's prompt.
  dependsOn: z.array(z.string().min(1)).default([]),
})
export type DelegationItem = z.infer<typeof DelegationItemSchema>

export const DelegateResultSchema = z.object({
  summary: z.string(),
  artifacts: z.array(ArtifactSchema),
  // Terminal disposition of a delegated child run, when known. Optional so
  // legacy rows (result-only) still parse.
  status: z.enum(['completed', 'failed', 'cancelled']).optional(),
})
export type DelegateResult = z.infer<typeof DelegateResultSchema>
