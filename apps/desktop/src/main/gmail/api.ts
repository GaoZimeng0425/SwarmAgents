// src/main/gmail/api.ts
//
// Thin Gmail REST client. Hand-rolled fetch (no `googleapis` dep) to match
// bilibili/api.ts. Each call sets Authorization: Bearer <token>; on 401 it asks
// the caller to refresh and retries once. 429/5xx use bounded exponential backoff.
import { createLogger } from '@shared/logger'
import type { GmailMessage, GmailThread } from '@shared/types/gmail'

const log = createLogger({ process: 'main' }).child({ component: 'gmail-api' })

const BASE = 'https://gmail.googleapis.com/gmail/v1'
export const MAX_THREADS = 200

export type GmailApi = {
  getProfile(): Promise<{ emailAddress: string }>
  listThreads(input?: { label?: string; max?: number }): Promise<{ threadIds: string[] }>
  fetchThread(id: string): Promise<{ thread: GmailThread; messages: GmailMessage[] }>
}

export type GmailApiDeps = {
  getAccessToken(): Promise<string>
  refreshAccessToken(): Promise<void>
}

// URL-safe base64 -> UTF-8 string (Gmail uses base64url for message bodies).
export function decodeBase64Url(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  return Buffer.from(b64, 'base64').toString('utf8')
}

type Payload = {
  mimeType?: string
  body?: { data?: string }
  parts?: Payload[]
  headers?: { name: string; value: string }[]
}

// Walk the MIME tree; prefer the first text/plain part, fall back to text/html
// (tags stripped). Returns '' when no textual part exists.
export function pickBodyText(payload: Payload): string {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      const t = pickBodyText(p)
      if (t) return t
    }
  }
  return ''
}

function header(payload: Payload, name: string): string {
  const hs = payload.headers ?? []
  return hs.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

// 429/5xx: bounded exponential backoff (max 3 attempts). 401: refresh + retry once.
const MAX_ATTEMPTS = 3
const BACKOFF_BASE_MS = 200

async function getJson(url: string, deps: GmailApiDeps): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const token = await deps.getAccessToken()
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (res.status === 401) {
      log.warn({ msg: 'gmail 401; refreshing and retrying once', url })
      await deps.refreshAccessToken()
      const token2 = await deps.getAccessToken()
      const res2 = await fetch(url, { headers: { authorization: `Bearer ${token2}` } })
      if (!res2.ok) {
        log.error({ msg: 'gmail api failed after refresh', status: res2.status, url })
        throw new Error(`gmail api ${res2.status}`)
      }
      return res2.json()
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
      const delayMs = BACKOFF_BASE_MS * 2 ** attempt
      log.warn({ msg: 'gmail retryable status; backing off', status: res.status, attempt, delayMs, url })
      await new Promise((r) => setTimeout(r, delayMs))
      continue
    }
    if (!res.ok) {
      log.error({ msg: 'gmail api non-ok', status: res.status, url })
      throw new Error(`gmail api ${res.status}`)
    }
    return res.json()
  }
}

export function createGmailApi(deps: GmailApiDeps): GmailApi {
  return {
    async getProfile() {
      log.debug({ msg: 'getProfile' })
      const j = (await getJson(`${BASE}/users/me/profile`, deps)) as { emailAddress?: string }
      return { emailAddress: j.emailAddress ?? '' }
    },

    async listThreads(input) {
      const max = Math.min(input?.max ?? MAX_THREADS, MAX_THREADS)
      const label = input?.label ?? 'INBOX'
      const u = new URL(`${BASE}/users/me/threads`)
      u.searchParams.set('labelIds', label)
      u.searchParams.set('maxResults', String(max))
      log.debug({ msg: 'listThreads', label, max })
      const j = (await getJson(u.toString(), deps)) as {
        threads?: { id: string }[]
        nextPageToken?: string
      }
      const threadIds = (j.threads ?? []).map((t) => t.id)
      log.info({ msg: 'listThreads done', count: threadIds.length })
      return { threadIds }
    },

    async fetchThread(id) {
      log.debug({ msg: 'fetchThread', id })
      const j = (await getJson(`${BASE}/users/me/threads/${id}`, deps)) as {
        id: string
        snippet?: string
        labelIds?: string[]
        messages?: Array<{
          id: string
          threadId: string
          snippet?: string
          labelIds?: string[]
          internalDate?: string
          payload?: Payload
        }>
      }
      const msgs = j.messages ?? []
      const messages: GmailMessage[] = msgs.map((m) => {
        const from = header(m.payload ?? {}, 'From')
        const to = header(m.payload ?? {}, 'To')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        return {
          id: m.id,
          threadId: m.threadId,
          fromAddr: from,
          toAddrs: to,
          subject: header(m.payload ?? {}, 'Subject'),
          snippet: m.snippet ?? '',
          bodyText: pickBodyText(m.payload ?? {}),
          dateMs: m.internalDate ? Number(m.internalDate) : 0,
          labelIds: m.labelIds ?? [],
        }
      })
      const last = messages[messages.length - 1]
      const thread: GmailThread = {
        id: j.id,
        snippet: j.snippet ?? '',
        fromAddr: last?.fromAddr ?? '',
        subject: last?.subject ?? '',
        lastDateMs: last?.dateMs ?? 0,
        labelIds: j.labelIds ?? [],
        unread: (j.labelIds ?? []).includes('UNREAD'),
      }
      log.info({ msg: 'fetchThread done', id, messageCount: messages.length })
      return { thread, messages }
    },
  }
}
