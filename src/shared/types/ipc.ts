import { z } from 'zod'

import { TaskEventSchema, TaskResultSchema, TaskSchema } from './task'

export const RiskSchema = z.enum(['low', 'medium', 'high'])
export type Risk = z.infer<typeof RiskSchema>

const ToolResultPayloadSchema = z.union([
  z.object({ kind: z.literal('json'), value: z.unknown() }),
  z.object({ kind: z.literal('image'), path: z.string(), w: z.number(), h: z.number(), sha: z.string() }),
  z.object({ kind: z.literal('text'), text: z.string() }),
])

const ToolResultSchema = z.union([
  z.object({ ok: z.literal(true), payload: ToolResultPayloadSchema }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
])

const ErrorRecordSchema = z.object({
  code: z.string(),
  message: z.string(),
  tier: z.enum(['transient', 'recoverable', 'fatal', 'gave_up']),
  stack: z.string().optional(),
})

export const InboundSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task.assign'), task: TaskSchema, promptContext: z.string() }),
  z.object({ type: z.literal('task.cancel'), taskId: z.string() }),
  z.object({ type: z.literal('tool.result'), callId: z.string(), result: ToolResultSchema }),
  z.object({
    type: z.literal('permission.decision'),
    actionId: z.string(),
    decision: z.enum(['grant', 'deny', 'skip']),
  }),
  z.object({ type: z.literal('shutdown') }),
])
export type Inbound = z.infer<typeof InboundSchema>

export const OutboundSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tool.call'),
    callId: z.string(),
    server: z.string(),
    tool: z.string(),
    args: z.unknown(),
  }),
  z.object({
    type: z.literal('permission.request'),
    actionId: z.string(),
    risk: RiskSchema,
    summary: z.string(),
    payload: z.unknown(),
  }),
  z.object({ type: z.literal('progress'), event: TaskEventSchema }),
  z.object({ type: z.literal('task.complete'), taskId: z.string(), result: TaskResultSchema }),
  z.object({
    type: z.literal('task.handoff'),
    parentTaskId: z.string(),
    newGoal: z.string(),
    suggestedTools: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal('task.error'), taskId: z.string(), error: ErrorRecordSchema }),
  z.object({ type: z.literal('heartbeat'), ts: z.number() }),
])
export type Outbound = z.infer<typeof OutboundSchema>

// ---- Renderer ↔ Main system bridge (added by spec §5) ----

/** RRGGBBAA hex string emitted by Electron systemPreferences on macOS/Windows. */
export const AccentColorSchema = z.object({
  hex: z.string().regex(/^[0-9a-fA-F]{6,8}$/),
})
export type AccentColor = z.infer<typeof AccentColorSchema>
