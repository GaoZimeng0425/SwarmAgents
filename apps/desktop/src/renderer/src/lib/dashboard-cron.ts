// Pure selector for the dashboard's 定时任务 section. Sorts upcoming jobs by
// nextRun, limits to 5, and derives a per-row status from the most recent past
// CronRun (success/failed) or, with no past runs, a countdown to nextRun.

import type { CronRun, ScheduledTask } from '@swarm/protocol'
import { orderBy } from 'es-toolkit'

export type CronStatusKind = 'success' | 'failed' | 'pending'

export type DashboardCronRow = {
  id: string
  /** Display name: job.name (preferred) → prompt (fallback). */
  name: string
  /** Localized next-run label, e.g. "每天 9:00" / "周一 8:30" / "明天". */
  timeLabel: string
  statusKind: CronStatusKind
  statusLabel: string
}

const DAY = 86_400_000

export function selectDashboardCron(jobs: ScheduledTask[], runs: CronRun[], now: number): { rows: DashboardCronRow[] } {
  // Most recent run per job (by triggeredAt) → status/error lookup.
  const latestRunByJob = new Map<string, CronRun>()
  for (const r of runs) {
    const cur = latestRunByJob.get(r.jobId)
    if (!cur || r.triggeredAt > cur.triggeredAt) latestRunByJob.set(r.jobId, r)
  }

  // Sort: jobs with a nextRun ascending first; null nextRuns last. Use Number
  // max-safe as the sort key for nulls so they sink below all real timestamps.
  const sorted = orderBy(jobs, [(j) => j.nextRun ?? Number.MAX_SAFE_INTEGER], ['asc'])

  const rows = sorted.slice(0, 5).map((j): DashboardCronRow => {
    const name = j.name ?? j.prompt
    const latest = j.lastRunAt != null ? latestRunByJob.get(j.id) : undefined
    let statusKind: CronStatusKind
    let statusLabel: string
    if (latest) {
      const ok = latest.status === 'completed'
      statusKind = ok ? 'success' : 'failed'
      statusLabel = ok ? '上次成功' : '上次失败'
    } else {
      statusKind = 'pending'
      statusLabel = countdownLabel(j.nextRun, now)
    }
    return { id: j.id, name, timeLabel: timeLabelFor(j), statusKind, statusLabel }
  })

  return { rows }
}

// Render a cron job's schedule as a human label. Phase 2 keeps this lightweight:
// prefer nextRun-derived weekday+time; fall back to the raw cron expression.
// (A full cron→human parser is out of scope — the design mockups show simple
// daily/weekly schedules; if a complex expression appears, show it verbatim.)
function timeLabelFor(j: ScheduledTask): string {
  if (j.nextRun != null) return weekdayTimeLabel(j.nextRun)
  return j.cron
}

function weekdayTimeLabel(ts: number): string {
  const d = new Date(ts)
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${weekdays[d.getDay()]} ${hh}:${mm}`
}

function countdownLabel(nextRun: number | null, now: number): string {
  if (nextRun == null) return '待调度'
  const diff = nextRun - now
  if (diff < DAY) return '即将运行'
  const days = Math.floor(diff / DAY)
  if (days === 1) return '明天'
  return `${days} 天后`
}
