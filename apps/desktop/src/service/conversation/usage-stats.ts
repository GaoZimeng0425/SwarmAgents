import type { DayBucket } from '@swarm/protocol'
import { format, startOfDay, subDays } from 'date-fns'

/** Local-time 'yyyy-MM-dd' — matches SQLite date(.., 'unixepoch', 'localtime'). */
export function dayKey(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

/** `count` ascending day keys, last element = the day of `now`. */
export function dayKeysEndingAt(now: Date, count: number): string[] {
  const keys: string[] = []
  for (let i = count - 1; i >= 0; i--) keys.push(dayKey(subDays(now, i)))
  return keys
}

/** Epoch-ms of the start of the day `rangeDays - 1` days before `now`. */
export function rangeCutoffMs(now: Date, rangeDays: number): number {
  return startOfDay(subDays(now, rangeDays - 1)).getTime()
}

/** Consecutive active days ending today (0 if today is not active). */
export function currentStreak(activeKeys: Set<string>, now: Date): number {
  let streak = 0
  for (let i = 0; ; i++) {
    if (!activeKeys.has(dayKey(subDays(now, i)))) break
    streak++
  }
  return streak
}

/** One bucket per key (in order); tokens from `rows` when present, else 0. */
export function zeroFillDaily(rows: DayBucket[], keys: string[]): DayBucket[] {
  const byDate = new Map(rows.map((r) => [r.date, r.tokens]))
  return keys.map((date) => ({ date, tokens: byDate.get(date) ?? 0 }))
}
