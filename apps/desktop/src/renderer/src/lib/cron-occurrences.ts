import { CronTime } from 'cron'

// Expand a cron expression into every run time within [from, to] (inclusive).
// Pure + client-side so the calendar can re-expand on month navigation with no
// IPC. Returns [] for an invalid expression (callers render nothing for it).
const MAX_OCCURRENCES = 5000 // safety cap: ~one run/minute for ~3.5 days

export function occurrencesInRange(cronExpr: string, from: Date, to: Date): Date[] {
  if (!CronTime.validateCronExpression(cronExpr).valid) return []
  const out: Date[] = []
  try {
    const ct = new CronTime(cronExpr)
    let cursor = new Date(from.getTime() - 1000) // so a run exactly at `from` is included
    for (let i = 0; i < MAX_OCCURRENCES; i++) {
      const next = ct.getNextDateFrom(cursor).toJSDate()
      if (next > to) break
      out.push(next)
      cursor = new Date(next.getTime() + 1000)
    }
  } catch {
    return []
  }
  return out
}
