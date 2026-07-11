// Workbench state machine. Single source of truth for the task board. Wraps the
// Store with business logic ported from WorkPanel's TodoStore + BoardStore, plus
// a state-change broadcast for the IPC layer. A failed persist does NOT advance
// the in-memory state.
import { randomUUID } from 'node:crypto'
import { createLogger } from '@shared/logger'
import type {
  CreateTaskInput,
  MoveTaskInput,
  Priority,
  UpdateTaskInput,
  WorkbenchColumn,
  WorkbenchData,
  WorkbenchMutationResult,
  WorkbenchTask,
} from '@swarm/protocol'

import type { Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'workbench-service' })

const PRIORITY_RANK: Record<Priority, number> = { high: 2, medium: 1, low: 0 }

/** Default columns seeded when the board is empty. Mirrors Linear's workflow:
 *  Backlog → Todo → In Progress → Done. */
const DEFAULT_COLUMN_NAMES = ['待办', '待处理', '进行中', '已完成']

/** Priority desc → deadline asc (nil sorts after) → createdAt asc. Ported from TaskFilter.sortRule. */
function sortRule(a: WorkbenchTask, b: WorkbenchTask): number {
  if (a.priority !== b.priority) return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]
  if (a.deadline && b.deadline) return a.deadline < b.deadline ? -1 : 1
  if (a.deadline) return -1
  if (b.deadline) return 1
  return a.createdAt < b.createdAt ? -1 : 1
}

export type Service = {
  getAll(): WorkbenchData
  createTask(input: CreateTaskInput): Promise<WorkbenchMutationResult>
  updateTask(id: string, patch: UpdateTaskInput): Promise<WorkbenchMutationResult>
  completeTask(id: string): Promise<WorkbenchMutationResult>
  reopenTask(id: string): Promise<WorkbenchMutationResult>
  deleteTask(id: string): Promise<WorkbenchMutationResult>
  moveTask(input: MoveTaskInput): Promise<WorkbenchMutationResult>
  addColumn(name: string): Promise<WorkbenchMutationResult>
  renameColumn(id: string, name: string): Promise<WorkbenchMutationResult>
  deleteColumn(id: string): Promise<WorkbenchMutationResult>
  reorderColumns(orderedIds: string[]): Promise<WorkbenchMutationResult>
  onStateChanged(cb: (data: WorkbenchData) => void): () => void
}

export async function createService(opts: { store: Store }): Promise<Service> {
  const state = await opts.store.load()
  seedDefaultColumnsIfNeeded()
  const listeners = new Set<(data: WorkbenchData) => void>()

  // --- internals ---

  function snapshot(): WorkbenchData {
    return { tasks: state.tasks, columns: state.columns }
  }

  function broadcast(): void {
    const data = snapshot()
    for (const cb of listeners) cb(data)
  }

  /** Persist current state to disk, then broadcast. Errors are logged + swallowed
   *  (in-memory state advances regardless; caller already mutated it). */
  async function persist(): Promise<void> {
    try {
      await opts.store.save(state)
    } catch (e) {
      log.error({ msg: 'failed to persist workbench data', err: e instanceof Error ? e.message : String(e) })
    }
    broadcast()
  }

  function ok(): WorkbenchMutationResult {
    return { ok: true }
  }

  function fail(message: string): WorkbenchMutationResult {
    return { ok: false, message }
  }

  function seedDefaultColumnsIfNeeded(): void {
    if (state.columns.length > 0) return
    const now = new Date().toISOString()
    const created: WorkbenchColumn[] = DEFAULT_COLUMN_NAMES.map((name, order) => ({
      id: randomUUID(),
      name,
      order,
      modifiedAt: now,
      isDefault: true,
    }))
    state.columns = created
    // Assign existing uncompleted tasks to the first column (mirrors BoardStore).
    const incomplete = state.tasks.filter((t) => !t.isCompleted).sort(sortRule)
    for (let i = 0; i < incomplete.length; i++) {
      incomplete[i].columnId = created[0].id
      incomplete[i].boardOrder = i
    }
    log.info({ msg: 'seeded default workbench columns', count: created.length })
  }

  function findTask(id: string): WorkbenchTask | undefined {
    return state.tasks.find((t) => t.id === id)
  }

  // --- public API ---

  return {
    getAll: () => snapshot(),

    async createTask(input) {
      const now = new Date().toISOString()
      const col = state.columns.find((c) => c.id === input.columnId) ?? state.columns[0]
      const siblings = state.tasks.filter((t) => !t.isCompleted && t.columnId === (col?.id ?? null))
      const task: WorkbenchTask = {
        id: randomUUID(),
        title: input.title,
        notes: input.notes,
        deadline: input.deadline ?? null,
        startDate: input.startDate ?? null,
        priority: input.priority,
        tags: input.tags,
        isCompleted: false,
        completedAt: null,
        createdAt: now,
        modifiedAt: now,
        columnId: col?.id ?? null,
        boardOrder: siblings.length,
      }
      state.tasks.push(task)
      await persist()
      log.info({ msg: 'task created', taskId: task.id, title: task.title })
      return ok()
    },

    async updateTask(id, patch) {
      const task = findTask(id)
      if (!task) return fail(`task ${id} not found`)
      if (patch.title !== undefined) task.title = patch.title
      if (patch.notes !== undefined) task.notes = patch.notes
      if (patch.deadline !== undefined) task.deadline = patch.deadline
      if (patch.startDate !== undefined) task.startDate = patch.startDate
      if (patch.priority !== undefined) task.priority = patch.priority
      if (patch.tags !== undefined) task.tags = patch.tags
      if (patch.columnId !== undefined) task.columnId = patch.columnId
      task.modifiedAt = new Date().toISOString()
      await persist()
      log.info({ msg: 'task updated', taskId: id })
      return ok()
    },

    async completeTask(id) {
      const task = findTask(id)
      if (!task) return fail(`task ${id} not found`)
      const now = new Date().toISOString()
      task.isCompleted = true
      task.completedAt = now
      task.modifiedAt = now
      await persist()
      log.info({ msg: 'task completed', taskId: id })
      return ok()
    },

    async reopenTask(id) {
      const task = findTask(id)
      if (!task) return fail(`task ${id} not found`)
      const now = new Date().toISOString()
      task.isCompleted = false
      task.completedAt = null
      task.modifiedAt = now
      await persist()
      log.info({ msg: 'task reopened', taskId: id })
      return ok()
    },

    async deleteTask(id) {
      const idx = state.tasks.findIndex((t) => t.id === id)
      if (idx < 0) return fail(`task ${id} not found`)
      // Capture columnId BEFORE splice — after removal, state.tasks[idx] points
      // at the next task (or is out of bounds), so the reindex would target the
      // wrong column.
      const colId = state.tasks[idx].columnId
      state.tasks.splice(idx, 1)
      reindexColumn(colId)
      await persist()
      log.info({ msg: 'task deleted', taskId: id })
      return ok()
    },

    async moveTask(input) {
      const task = findTask(input.taskId)
      if (!task) return fail(`task ${input.taskId} not found`)
      const movingWithinColumn = task.columnId === input.columnId
      const oldOrder = task.boardOrder
      task.columnId = input.columnId
      // Siblings = uncompleted tasks already in the target column, excluding the moved task.
      const siblings = state.tasks
        .filter((t) => !t.isCompleted && t.columnId === input.columnId && t.id !== input.taskId)
        .sort((a, b) => a.boardOrder - b.boardOrder)
      let target = input.index
      // Same-column downward move: remove-self shifts the target back by one.
      if (movingWithinColumn && oldOrder < input.index) target -= 1
      target = Math.max(0, Math.min(target, siblings.length))
      siblings.splice(target, 0, task)
      for (let i = 0; i < siblings.length; i++) siblings[i].boardOrder = i
      task.modifiedAt = new Date().toISOString()
      await persist()
      log.info({ msg: 'task moved', taskId: input.taskId, columnId: input.columnId, index: input.index })
      return ok()
    },

    async addColumn(name) {
      const nextOrder = state.columns.reduce((max, c) => Math.max(max, c.order), -1) + 1
      const col: WorkbenchColumn = {
        id: randomUUID(),
        name,
        order: nextOrder,
        modifiedAt: new Date().toISOString(),
        isDefault: false,
      }
      state.columns.push(col)
      await persist()
      log.info({ msg: 'column added', columnId: col.id, name })
      return ok()
    },

    async renameColumn(id, name) {
      const col = state.columns.find((c) => c.id === id)
      if (!col) return fail(`column ${id} not found`)
      col.name = name
      col.modifiedAt = new Date().toISOString()
      await persist()
      log.info({ msg: 'column renamed', columnId: id, name })
      return ok()
    },

    async deleteColumn(id) {
      const col = state.columns.find((c) => c.id === id)
      if (!col) return fail(`column ${id} not found`)
      if (col.isDefault) return fail('cannot delete a default column')
      const target = state.columns.find((c) => c.id !== id)
      if (!target) return fail('cannot delete the last column')
      // Move tasks from the deleted column to the fallback column.
      for (const task of state.tasks) {
        if (task.columnId === id) task.columnId = target.id
      }
      reindexColumn(target.id)
      state.columns = state.columns.filter((c) => c.id !== id)
      await persist()
      log.info({ msg: 'column deleted', columnId: id })
      return ok()
    },

    async reorderColumns(orderedIds) {
      const map = new Map(state.columns.map((c) => [c.id, c]))
      const now = new Date().toISOString()
      for (let i = 0; i < orderedIds.length; i++) {
        const col = map.get(orderedIds[i])
        if (col) {
          col.order = i
          col.modifiedAt = now
        }
      }
      state.columns.sort((a, b) => a.order - b.order)
      await persist()
      log.info({ msg: 'columns reordered', count: orderedIds.length })
      return ok()
    },

    onStateChanged(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }

  /** Reindex boardOrder (0,1,2,…) for all uncompleted tasks in a column. */
  function reindexColumn(columnId: string | null): void {
    const siblings = state.tasks
      .filter((t) => !t.isCompleted && t.columnId === columnId)
      .sort((a, b) => a.boardOrder - b.boardOrder)
    for (let i = 0; i < siblings.length; i++) siblings[i].boardOrder = i
  }
}
