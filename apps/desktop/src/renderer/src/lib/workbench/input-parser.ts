// One-line task parser — ported from WorkPanel's InputParser.swift.
// Tokenizes input by whitespace + full-width space, then classifies each token
// in priority order: priority, urgency, tags, recurrence, time, date. Everything
// else is the title. If any date/time is present, the deadline defaults to 18:00
// when only a day is given.
//
// Pure function: no React, no IO. The output feeds CreateTaskInput.
import type { Priority, RecurrenceRule } from '@swarm/protocol'

export type ParsedInput = {
  title: string
  deadline: string | null
  priority: Priority
  tags: string[]
  recurrence: RecurrenceRule | null
  urgencyOverride: boolean | null
}

const priorityMap: Record<string, Priority> = {
  '!高': 'high',
  '!中': 'medium',
  '!低': 'low',
  '!1': 'high',
  '!2': 'medium',
  '!3': 'low',
}

const urgencyMap: Record<string, boolean> = {
  '!紧急': true,
  '!urgent': true,
  '!不紧急': false,
  '!非紧急': false,
}

// JS getDay(): Sunday = 0, Monday = 1, …, Saturday = 6.
// WorkPanel's weekdayMap uses Calendar weekday: Sunday = 1 … Saturday = 7.
// Here we map the Chinese suffix directly to JS getDay() for nextWeekday math.
const weekdayMap: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
}

const relativeDayMap: Record<string, number> = {
  今天: 0,
  今日: 0,
  明天: 1,
  明日: 1,
  后天: 2,
  大后天: 3,
}

function parseRecurrence(token: string, now: Date): { rule: RecurrenceRule; day: Date | null } | null {
  if (token === '每天' || token === '每日') return { rule: 'daily', day: null }
  if (token === '每月') return { rule: 'monthly', day: null }
  if (token === '工作日' || token === '每个工作日') return { rule: 'weekdays', day: null }
  if (token.startsWith('每周') || token.startsWith('每星期')) {
    const suffix = token.startsWith('每星期') ? token.slice(3) : token.slice(2)
    const wd = weekdayMap[suffix]
    if (wd !== undefined) return { rule: 'weekly', day: nextWeekday(wd, now, false) }
  }
  return null
}

function parseDate(token: string, now: Date): Date | null {
  const offset = relativeDayMap[token]
  if (offset !== undefined) {
    const d = new Date(now)
    d.setDate(d.getDate() + offset)
    return startOfDay(d)
  }
  if (token.startsWith('下周') || token.startsWith('下星期')) {
    const suffix = token.startsWith('下星期') ? token.slice(3) : token.slice(2)
    const wd = weekdayMap[suffix]
    if (wd !== undefined) return nextWeekday(wd, now, true)
  }
  if (token.startsWith('周') || token.startsWith('星期')) {
    const suffix = token.startsWith('星期') ? token.slice(2) : token.slice(1)
    const wd = weekdayMap[suffix]
    if (wd !== undefined) return nextWeekday(wd, now, false)
  }
  return null
}

function parseTime(token: string): { hour: number; minute: number } | null {
  let t = token
  let pmOffset = 0
  if (t.startsWith('上午')) {
    t = t.slice(2)
  } else if (t.startsWith('下午') || t.startsWith('晚上')) {
    t = t.slice(2)
    pmOffset = 12
  } else if (t === '中午') {
    return { hour: 12, minute: 0 }
  }

  // HH:MM
  let m = t.match(/^(\d{1,2}):(\d{2})$/)
  if (m) {
    const h = Number(m[1])
    const min = Number(m[2])
    if (h < 24 && min < 60) return { hour: applyPM(h, pmOffset), minute: min }
    return null
  }
  // X点 / X点半 / X点Y分
  m = t.match(/^(\d{1,2})点(半|\d{1,2}分?)?$/)
  if (m) {
    const h = Number(m[1])
    let min = 0
    if (m[2]) {
      if (m[2] === '半') min = 30
      else min = Number(m[2].replace('分', ''))
    }
    if (h < 24 && min < 60) return { hour: applyPM(h, pmOffset), minute: min }
    return null
  }
  return null
}

function applyPM(hour: number, pmOffset: number): number {
  if (pmOffset !== 12) return hour
  return hour < 12 ? hour + 12 : hour
}

/** Next occurrence of the given weekday (JS getDay: 0=Sun..6=Sat) from `now`.
 *  nextWeek=true → the one in the following week. */
function nextWeekday(target: number, now: Date, nextWeek: boolean): Date {
  const today = now.getDay()
  let add = (target - today + 7) % 7
  if (nextWeek) add += 7
  const d = new Date(now)
  d.setDate(d.getDate() + add)
  return startOfDay(d)
}

function startOfDay(d: Date): Date {
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  return r
}

/** Parse a one-line input string into structured task fields. */
export function parseInput(input: string, now: Date = new Date()): ParsedInput {
  const result: ParsedInput = {
    title: '',
    deadline: null,
    priority: 'medium',
    tags: [],
    recurrence: null,
    urgencyOverride: null,
  }

  const titleWords: string[] = []
  let dayDate: Date | null = null
  let time: { hour: number; minute: number } | null = null

  const tokens = input.split(/[ \u3000]+/).filter(Boolean)

  for (const token of tokens) {
    if (priorityMap[token] !== undefined) {
      result.priority = priorityMap[token]
    } else if (urgencyMap[token] !== undefined) {
      result.urgencyOverride = urgencyMap[token]
    } else if (token.startsWith('#') && token.length > 1) {
      result.tags.push(token.slice(1))
    } else {
      const rec = parseRecurrence(token, now)
      if (rec) {
        result.recurrence = rec.rule
        if (rec.day) dayDate = rec.day
        continue
      }
      const t = parseTime(token)
      if (t) {
        time = t
        continue
      }
      const d = parseDate(token, now)
      if (d) {
        dayDate = d
        continue
      }
      titleWords.push(token)
    }
  }

  if (dayDate || time) {
    const base = dayDate ?? startOfDay(now)
    base.setHours(time?.hour ?? 18, time?.minute ?? 0, 0, 0)
    result.deadline = base.toISOString()
  }

  result.title = titleWords.join(' ')
  return result
}
