// src/main/gmail/api.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createGmailApi, decodeBase64Url, pickBodies } from './api'

const okJson = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

afterEach(() => vi.restoreAllMocks())

describe('gmail api helpers', () => {
  it('decodeBase64Url decodes url-safe base64', () => {
    expect(decodeBase64Url('SGVsbG8')).toBe('Hello') // "Hello" -> SGVsbG8=
  })

  it('pickBodies prefers text/plain and also captures raw html', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: 'SGVsbG8=' } }, // "Hello"
        { mimeType: 'text/html', body: { data: 'PGI+aGk8L2I+' } }, // "<b>hi</b>"
      ],
    }
    const r = pickBodies(payload as never)
    expect(r.text).toBe('Hello')
    expect(r.html).toBe('<b>hi</b>')
  })

  it('pickBodies recurses into multipart', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: 'SGk=' } }] }],
    }
    expect(pickBodies(payload as never).text).toBe('Hi')
  })

  it('pickBodies strips html to text when there is no text/plain part', () => {
    const r = pickBodies({ mimeType: 'text/html', body: { data: 'PGI+aGk8L2I+' } } as never)
    expect(r.text).toBe('hi')
    expect(r.html).toBe('<b>hi</b>')
  })

  it('pickBodies returns empty when no text part', () => {
    expect(pickBodies({ mimeType: 'application/pdf', body: {} } as never)).toEqual({ text: '', html: '' })
  })
})

describe('gmail api client', () => {
  it('listThreads + fetchThread normalize', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okJson({ threads: [{ id: 't1' }, { id: 't2' }] }))
      .mockResolvedValueOnce(
        okJson({
          id: 't1',
          snippet: 'snip',
          labelIds: ['INBOX'],
          messages: [
            {
              id: 'm1',
              threadId: 't1',
              snippet: 'ms',
              labelIds: ['INBOX'],
              internalDate: '1000',
              payload: {
                headers: [
                  { name: 'From', value: 'a@x.com' },
                  { name: 'To', value: 'c@d.com' },
                  { name: 'Subject', value: 'Hi' },
                ],
                mimeType: 'text/plain',
                body: { data: 'SGVsbG8=' },
              },
            },
          ],
        })
      )
    const api = createGmailApi({
      getAccessToken: async () => 'AT',
      refreshAccessToken: async () => {},
    })
    const listed = await api.listThreads({ max: 10 })
    expect(listed.threadIds).toEqual(['t1', 't2'])
    const full = await api.fetchThread('t1')
    expect(full.thread.id).toBe('t1')
    expect(full.messages[0].bodyText).toBe('Hello')
    expect(full.messages[0].htmlBody).toBe('')
    expect(full.messages[0].fromAddr).toBe('a@x.com')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Authorization header carried.
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer AT')
  })

  it('on 401 refreshes and retries once', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as Response)
      .mockResolvedValueOnce(okJson({ threads: [] }))
    const refresh = vi.fn(async () => {})
    const api = createGmailApi({ getAccessToken: async () => 'AT', refreshAccessToken: refresh })
    await api.listThreads({ max: 5 })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('on 429 backs off then succeeds', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) } as Response)
      .mockResolvedValueOnce(okJson({ threads: [] }))
    const api = createGmailApi({ getAccessToken: async () => 'AT', refreshAccessToken: async () => {} })
    await api.listThreads({ max: 5 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('getHistory parses adds/deletes/inbox-leaves as changed, plus UNREAD flips', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson({
        historyId: '999',
        history: [
          { messagesAdded: [{ message: { threadId: 'tNew' } }] },
          { messagesDeleted: [{ message: { threadId: 'tDeleted' } }] },
          { labelsRemoved: [{ message: { threadId: 'tArchived' }, labelIds: ['INBOX'] }] },
          { labelsAdded: [{ message: { threadId: 'tTrashed' }, labelIds: ['TRASH'] }] },
          { labelsRemoved: [{ message: { threadId: 'tRead' }, labelIds: ['UNREAD'] }] },
          { labelsAdded: [{ message: { threadId: 'tUnread' }, labelIds: ['UNREAD'] }] },
          // A non-actionable label change must be ignored.
          { labelsRemoved: [{ message: { threadId: 'tOther' }, labelIds: ['IMPORTANT'] }] },
        ],
      })
    )
    const api = createGmailApi({ getAccessToken: async () => 'AT', refreshAccessToken: async () => {} })
    const r = await api.getHistory('100')
    expect(r.expired).toBe(false)
    if (!r.expired) {
      expect(r.changedThreadIds.sort()).toEqual(['tArchived', 'tDeleted', 'tNew', 'tTrashed'])
      expect(r.readThreadIds).toEqual(['tRead'])
      expect(r.unreadThreadIds).toEqual(['tUnread'])
      expect(r.changedThreadIds).not.toContain('tOther')
      expect(r.newHistoryId).toBe('999')
    }
  })

  it('getHistory reports expired on a 404 (stale cursor)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response)
    const api = createGmailApi({ getAccessToken: async () => 'AT', refreshAccessToken: async () => {} })
    expect(await api.getHistory('1')).toEqual({ expired: true })
  })

  it('getInboxTotal reads threadsTotal from the INBOX label', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson({ id: 'INBOX', threadsTotal: 1234, messagesTotal: 5000 })
    )
    const api = createGmailApi({ getAccessToken: async () => 'AT', refreshAccessToken: async () => {} })
    expect(await api.getInboxTotal()).toBe(1234)
  })

  it('markThreadRead POSTs a removeLabelIds:[UNREAD] modify request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ id: 't1' }))
    const api = createGmailApi({ getAccessToken: async () => 'AT', refreshAccessToken: async () => {} })
    await api.markThreadRead('t1')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/users/me/threads/t1/modify')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ removeLabelIds: ['UNREAD'] })
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer AT')
  })
})
