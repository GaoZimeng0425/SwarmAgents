// src/shared/types/gmail.test.ts
import { describe, expect, it } from 'vitest'

import {
  defaultGmailConfigOnDisk,
  GmailConfigOnDisk,
  GmailConfigViewSchema,
  GmailMessageSchema,
  GmailThreadSchema,
} from './gmail'

describe('gmail types', () => {
  it('default config is valid and empty', () => {
    const d = defaultGmailConfigOnDisk()
    expect(d.clientCreds).toBeNull()
    expect(d.tokens).toBeNull()
    expect(d.accountEmail).toBeNull()
    expect(() => GmailConfigOnDisk.parse(d)).not.toThrow()
  })

  it('parses a thread row', () => {
    const t = GmailThreadSchema.parse({
      id: 't1',
      snippet: 'hi',
      fromAddr: 'a@b.com',
      subject: 'S',
      lastDateMs: 1,
      labelIds: ['INBOX'],
      unread: true,
    })
    expect(t.unread).toBe(true)
  })

  it('parses a message row', () => {
    const m = GmailMessageSchema.parse({
      id: 'm1',
      threadId: 't1',
      fromAddr: 'a@b.com',
      toAddrs: ['c@d.com'],
      subject: 'S',
      snippet: 'snip',
      bodyText: 'body',
      htmlBody: '<p>body</p>',
      dateMs: 2,
      labelIds: ['INBOX'],
    })
    expect(m.bodyText).toBe('body')
  })

  it('view omits secrets', () => {
    const v = GmailConfigViewSchema.parse({
      hasClientCreds: true,
      loggedIn: false,
      accountEmail: null,
      lastSyncAt: null,
      messageCount: null,
      syncError: null,
    })
    expect(v.hasClientCreds).toBe(true)
  })
})
