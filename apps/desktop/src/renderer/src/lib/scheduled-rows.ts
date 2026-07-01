import type { CronRun } from '@shared/types/ui'
import { orderBy } from 'es-toolkit'

import type { TaskRecord, TaskStatus } from './apply-event'

// One scheduled run, flattened for the read-only results list. Derived from the
// run's top-level task, enriched with cron metadata (job name, run error) when a
// cron_run links them. Pure; unit-tested.
export type ScheduledRow = {
  taskId: string
  name: string
  status: TaskStatus
  startedAt: number
  durationMs?: number
  summary: string | null
  error: string | null
}

// Map system-session top-level tasks to result rows, newest first. The cron job
// name (preferred over the raw goal) and the run error are joined via the
// cron_run whose taskId matches; a missing/null name falls back to task.goal so
// manual or legacy tasks still render.
export function buildScheduledRows(
  tasks: TaskRecord[],
  runs: CronRun[],
  jobs: ReadonlyArray<{ id: string; name: string | null }>
): ScheduledRow[] {
  const jobName = new Map(jobs.map((j) => [j.id, j.name]))
  const runByTaskId = new Map<string, CronRun>()
  for (const r of runs) if (r.taskId) runByTaskId.set(r.taskId, r)

  const rows = tasks
    .filter((t) => !t.parentTaskId)
    .map((t) => {
      const run = runByTaskId.get(t.id)
      const name = (run ? jobName.get(run.jobId) : undefined) ?? t.goal
      return {
        taskId: t.id,
        name,
        status: t.status,
        startedAt: t.startedAt,
        durationMs: t.used?.wallMs,
        summary: t.summary,
        error: run?.error ?? null,
      }
    })
  return orderBy(rows, ['startedAt'], ['desc'])
}

// A run's full task set: the root plus every spawned sub-agent descendant
// (transitive), so the expanded transcript shows sub-agent blocks too.
export function collectSubtree(tasks: TaskRecord[], rootId: string): TaskRecord[] {
  const root = tasks.find((t) => t.id === rootId)
  if (!root) return []
  const byParent = new Map<string, TaskRecord[]>()
  for (const t of tasks) {
    if (!t.parentTaskId) continue
    const arr = byParent.get(t.parentTaskId) ?? []
    arr.push(t)
    byParent.set(t.parentTaskId, arr)
  }
  const out: TaskRecord[] = [root]
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    for (const child of byParent.get(id) ?? []) {
      out.push(child)
      stack.push(child.id)
    }
  }
  return out
}

// Human-readable run duration: "120ms" / "3.2s" / "2m 5s".
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(totalSec / 60)
  const rem = totalSec % 60
  return `${m}m ${rem}s`
}
