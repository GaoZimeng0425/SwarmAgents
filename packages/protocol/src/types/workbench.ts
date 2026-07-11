// Workbench (工作面板) wire types — the task board data model ported from the
// WorkPanel macOS app. Plain JSON on disk, over IPC, and in the renderer; no
// secrets so a single shape is used everywhere.
import { z } from 'zod'

export const PRIORITY_VALUES = ['low', 'medium', 'high'] as const
export type Priority = (typeof PRIORITY_VALUES)[number]

export const RECURRENCE_VALUES = ['daily', 'weekdays', 'weekly', 'monthly'] as const
export type RecurrenceRule = (typeof RECURRENCE_VALUES)[number]

// ISO-8601 string or null (Date.toISOString on the main side, parsed on the
// renderer side). Mirrors how the rest of @swarm/protocol carries timestamps.
export const WorkbenchTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().default(''),
  deadline: z.string().nullable().default(null),
  startDate: z.string().nullable().default(null),
  priority: z.enum(PRIORITY_VALUES).default('medium'),
  tags: z.array(z.string()).default([]),
  isCompleted: z.boolean().default(false),
  completedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  modifiedAt: z.string(),
  columnId: z.string().nullable().default(null),
  boardOrder: z.number().int().default(0),
})
export type WorkbenchTask = z.infer<typeof WorkbenchTaskSchema>

export const WorkbenchColumnSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number().int(),
  modifiedAt: z.string(),
  /** True for the four seeded default columns (待办/待处理/进行中/已完成).
   *  Default columns cannot be deleted, only renamed. */
  isDefault: z.boolean().default(false),
})
export type WorkbenchColumn = z.infer<typeof WorkbenchColumnSchema>

export const WorkbenchDataSchema = z.object({
  tasks: z.array(WorkbenchTaskSchema),
  columns: z.array(WorkbenchColumnSchema),
})
export type WorkbenchData = z.infer<typeof WorkbenchDataSchema>

/** Empty-state default: no tasks, no columns (service seeds columns on first access). */
export const emptyWorkbenchData = (): WorkbenchData => ({ tasks: [], columns: [] })

// --- Mutation inputs (validated at the IPC boundary) ------------------------

export const CreateTaskInputSchema = z.object({
  title: z.string().min(1),
  notes: z.string().optional().default(''),
  deadline: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  priority: z.enum(PRIORITY_VALUES).optional().default('medium'),
  tags: z.array(z.string()).optional().default([]),
  columnId: z.string().nullable().optional(),
})
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>

export const UpdateTaskInputSchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  deadline: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  priority: z.enum(PRIORITY_VALUES).optional(),
  tags: z.array(z.string()).optional(),
  columnId: z.string().nullable().optional(),
})
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>

export const MoveTaskInputSchema = z.object({
  taskId: z.string(),
  columnId: z.string(),
  index: z.number().int(),
})
export type MoveTaskInput = z.infer<typeof MoveTaskInputSchema>

export const AddColumnInputSchema = z.object({
  name: z.string().min(1),
})
export type AddColumnInput = z.infer<typeof AddColumnInputSchema>

export const RenameColumnInputSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
})
export type RenameColumnInput = z.infer<typeof RenameColumnInputSchema>

export type WorkbenchMutationResult = { ok: true } | { ok: false; message: string }
