import type { RunRecord, RunStatus } from '@shared/lib/apply-event'
import type { CronRun } from '@swarm/protocol'
import { orderBy } from 'es-toolkit'

// One scheduled run, flattened for the read-only results list. Derived from the
// run's top-level record, enriched with cron metadata (job name, run error) when
// a cron_run links them. Pure; unit-tested.
export type ScheduledRow = {
  runId: string
  name: string
  status: RunStatus
  startedAt: number
  durationMs?: number
  summary: string | null
  error: string | null
}

// Map system-session top-level tasks to result rows, newest first. The cron job
// name (preferred over the raw goal) and the run error are joined via the
// cron_run whose taskId matches; a missing/null name falls back to task.prompt so
// manual or legacy tasks still render.
export function buildScheduledRows(
  tasks: RunRecord[],
  runs: CronRun[],
  jobs: ReadonlyArray<{ id: string; name: string | null }>
): ScheduledRow[] {
  const jobName = new Map(jobs.map((j) => [j.id, j.name]))
  const runByTaskId = new Map<string, CronRun>()
  for (const r of runs) if (r.taskId) runByTaskId.set(r.taskId, r)

  const rows = tasks
    .filter((t) => !t.parentRunId)
    .map((t) => {
      const run = runByTaskId.get(t.id)
      const name = (run ? jobName.get(run.jobId) : undefined) ?? t.prompt
      return {
        runId: t.id,
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
export function collectSubtree(tasks: RunRecord[], rootId: string): RunRecord[] {
  const root = tasks.find((t) => t.id === rootId)
  if (!root) return []
  const byParent = new Map<string, RunRecord[]>()
  for (const t of tasks) {
    if (!t.parentRunId) continue
    const arr = byParent.get(t.parentRunId) ?? []
    arr.push(t)
    byParent.set(t.parentRunId, arr)
  }
  const out: RunRecord[] = [root]
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
