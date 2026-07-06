import type { GmailThread } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { classifyAll, classifyThread } from './classify-thread'

const NOW = new Date('2026-07-06T12:00:00').getTime()
const DAY = 86_400_000

function mk(over: Partial<GmailThread> & Pick<GmailThread, 'id'>): GmailThread {
  return { snippet: '', fromAddr: '', subject: '', lastDateMs: NOW, labelIds: [], unread: false, ...over }
}

describe('classifyThread', () => {
  it('news: CATEGORY_PROMOTIONS label', () => {
    expect(classifyThread(mk({ id: 't1', labelIds: ['CATEGORY_PROMOTIONS'] }), NOW)).toBe('news')
  })
  it('news: noreply sender', () => {
    expect(classifyThread(mk({ id: 't2', fromAddr: 'noreply@github.com' }), NOW)).toBe('news')
  })
  it('news: snippet has 退订', () => {
    expect(classifyThread(mk({ id: 't3', snippet: '点击退订' }), NOW)).toBe('news')
  })
  it('archive: read + older than 7 days', () => {
    expect(classifyThread(mk({ id: 't4', unread: false, lastDateMs: NOW - 8 * DAY }), NOW)).toBe('archive')
  })
  it('not archive: read but within 7 days', () => {
    expect(classifyThread(mk({ id: 't5', unread: false, lastDateMs: NOW - 3 * DAY }), NOW)).toBe('all')
  })
  it('important: IMPORTANT label', () => {
    expect(classifyThread(mk({ id: 't6', labelIds: ['IMPORTANT'] }), NOW)).toBe('important')
  })
  it('important: STARRED label', () => {
    expect(classifyThread(mk({ id: 't7', labelIds: ['STARRED'] }), NOW)).toBe('important')
  })
  it('reply: unread + question mark in snippet', () => {
    expect(classifyThread(mk({ id: 't8', unread: true, snippet: '能否今天确认?' }), NOW)).toBe('reply')
  })
  it('reply: unread + 请确认 phrase', () => {
    expect(classifyThread(mk({ id: 't9', unread: true, snippet: '请确认发布时间' }), NOW)).toBe('reply')
  })
  it('all: read recent non-news thread', () => {
    expect(classifyThread(mk({ id: 't10', unread: false, lastDateMs: NOW - 1 * DAY }), NOW)).toBe('all')
  })
  it('news wins over archive (promotion old + read)', () => {
    expect(
      classifyThread(
        mk({ id: 't11', labelIds: ['CATEGORY_PROMOTIONS'], unread: false, lastDateMs: NOW - 30 * DAY }),
        NOW
      )
    ).toBe('news')
  })
})

describe('classifyAll', () => {
  it('counts each group', () => {
    const threads = [
      mk({ id: 'n1', labelIds: ['CATEGORY_PROMOTIONS'] }),
      mk({ id: 'r1', unread: true, snippet: '是否?' }),
      mk({ id: 'a1', unread: false, lastDateMs: NOW - 10 * DAY }),
      mk({ id: 'x1', unread: false, lastDateMs: NOW }),
    ]
    const counts = classifyAll(threads, NOW)
    expect(counts.news).toBe(1)
    expect(counts.reply).toBe(1)
    expect(counts.archive).toBe(1)
    expect(counts.all).toBe(4) // 'all' is total count
  })
})
