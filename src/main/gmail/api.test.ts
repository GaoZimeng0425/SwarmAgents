// src/main/gmail/api.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createGmailApi, decodeBase64Url, pickBodyText } from './api'

const okJson = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

afterEach(() => vi.restoreAllMocks())

describe('gmail api helpers', () => {
  it('decodeBase64Url decodes url-safe base64', () => {
    expect(decodeBase64Url('SGVsbG8')).toBe('Hello') // "Hello" -> SGVsbG8=
  })

  it('pickBodyText prefers text/plain part', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: 'SGVsbG8=' } }, // "Hello"
        { mimeType: 'text/html', body: { data: 'PGI+aGk8L2I+' } },
      ],
    }
    expect(pickBodyText(payload as never)).toBe('Hello')
  })

  it('pickBodyText recurses into multipart', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: 'SGk=' } }] }],
    }
    expect(pickBodyText(payload as never)).toBe('Hi')
  })

  it('pickBodyText returns "" when no text part', () => {
    expect(pickBodyText({ mimeType: 'application/pdf', body: {} } as never)).toBe('')
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
})
