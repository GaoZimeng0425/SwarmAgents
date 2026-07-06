// Pure smart-grouping rules for the Gmail inbox. Zero React, zero IO. Mirrors
// the style of lib/calendar/build-insights.ts. `now` is injected for test
// determinism (defaults to Date.now()).
import type { GmailThread } from '@swarm/protocol'

export type GmailGroupKey = 'reply' | 'important' | 'archive' | 'news' | 'all'

const ARCHIVE_AGE_MS = 7 * 86_400_000
const NEWS_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_SOCIAL'])
const NEWS_FROM = /noreply@|notifications@|@github\.com|newsletter/i
const NEWS_SNIPPET = /退订|unsubscribe/i
const REPLY_QUESTION = /[?？]|如何|是否|能否|能不能|请确认|请问|帮忙|何时|什么时候/

export function classifyThread(thread: GmailThread, now: number = Date.now()): GmailGroupKey {
  const labels = new Set(thread.labelIds ?? [])
  // 1. news
  if ([...NEWS_LABELS].some((l) => labels.has(l))) return 'news'
  if (NEWS_FROM.test(thread.fromAddr ?? '')) return 'news'
  if (NEWS_SNIPPET.test(thread.snippet ?? '')) return 'news'
  // 2. archive (read + stale)
  if (thread.unread === false && now - thread.lastDateMs > ARCHIVE_AGE_MS) return 'archive'
  // 3. important
  if (labels.has('IMPORTANT') || labels.has('STARRED')) return 'important'
  // 4. reply
  if (thread.unread === true && REPLY_QUESTION.test(thread.snippet ?? '')) return 'reply'
  // 5. all (fallback)
  return 'all'
}

export function classifyAll(threads: GmailThread[], now?: number): Record<GmailGroupKey, number> {
  const counts: Record<GmailGroupKey, number> = { all: threads.length, reply: 0, important: 0, archive: 0, news: 0 }
  for (const t of threads) {
    const g = classifyThread(t, now)
    if (g !== 'all') counts[g]++
  }
  return counts
}
