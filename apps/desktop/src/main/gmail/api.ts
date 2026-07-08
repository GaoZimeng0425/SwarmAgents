// src/main/gmail/api.ts
//
// Thin Gmail REST client. Hand-rolled fetch (no `googleapis` dep) to match
// bilibili/api.ts. Each call sets Authorization: Bearer <token>; on 401 it asks
// the caller to refresh and retries once. 429/5xx use bounded exponential backoff.
import { createLogger } from '@shared/logger'
import type { GmailMessage, GmailThread } from '@swarm/protocol'

const log = createLogger({ process: 'main' }).child({ component: 'gmail-api' })

const BASE = 'https://gmail.googleapis.com/gmail/v1'
// Gmail's threads.list caps maxResults at 500 per page; beyond that you page
// with nextPageToken. We fetch a screenful at a time (50) and page with tokens.
const MAX_PAGE = 500

// Normalized incremental changes from users.history.list since a cursor.
// `expired` signals the stored historyId is too old (Gmail 404) → full resync.
export type HistoryChanges =
  | { expired: true }
  | {
      expired: false
      // Thread ids that need re-fetching + reconciling against INBOX membership:
      // new mail, deleted messages, or an INBOX-removal / TRASH-add elsewhere.
      // The caller re-fetches each and drops it from the cache if it left INBOX.
      changedThreadIds: string[]
      // Thread ids whose UNREAD label was removed / added elsewhere (cheap flip,
      // no re-fetch needed).
      readThreadIds: string[]
      unreadThreadIds: string[]
      // The latest historyId to persist as the next cursor.
      newHistoryId: string
    }

export type GmailApi = {
  // historyId is the mailbox-wide cursor; capture it as the incremental baseline.
  getProfile(): Promise<{ emailAddress: string; historyId: string }>
  // pageToken pages through the inbox oldest-ward; nextPageToken is null at the
  // end. max is a single-page size (capped at 500), NOT a total.
  listThreads(input?: {
    label?: string
    max?: number
    pageToken?: string
  }): Promise<{ threadIds: string[]; nextPageToken: string | null }>
  // Total number of INBOX threads — drives the pager's real page count.
  getInboxTotal(): Promise<number>
  fetchThread(id: string): Promise<{ thread: GmailThread; messages: GmailMessage[] }>
  // Incremental changes since startHistoryId (adds + UNREAD label flips).
  getHistory(startHistoryId: string): Promise<HistoryChanges>
  // Remove the UNREAD label from a whole thread (mark read on the server).
  // Requires the gmail.modify scope.
  markThreadRead(id: string): Promise<void>
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

// Walk the MIME tree; capture the first text/plain part (-> text) and the
// first text/html part (-> html, raw, for rich rendering). `text` falls back
// to a tags-stripped version of `html` so legacy plain-text / agent-tool
// rendering stays readable when there's no text/plain part.
export function pickBodies(payload: Payload): { text: string; html: string } {
  const found = { text: undefined as string | undefined, html: undefined as string | undefined }
  const walk = (p: Payload): void => {
    if (!p || (found.text && found.html)) return
    if (p.mimeType === 'text/plain' && p.body?.data && !found.text) {
      found.text = decodeBase64Url(p.body.data)
    } else if (p.mimeType === 'text/html' && p.body?.data && !found.html) {
      found.html = decodeBase64Url(p.body.data)
    }
    if (p.parts) {
      for (const part of p.parts) {
        walk(part)
        if (found.text && found.html) return
      }
    }
  }
  walk(payload)
  const html = found.html ?? ''
  const text =
    found.text ??
    (html
      ? html
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      : '')
  return { text, html }
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

// POST with a JSON body. Same 401-refresh-once + 429/5xx backoff policy as getJson.
async function postJson(url: string, body: unknown, deps: GmailApiDeps): Promise<unknown> {
  const payload = JSON.stringify(body)
  const send = (token: string): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: payload,
    })
  for (let attempt = 0; ; attempt++) {
    const token = await deps.getAccessToken()
    const res = await send(token)
    if (res.status === 401) {
      log.warn({ msg: 'gmail 401 (POST); refreshing and retrying once', url })
      await deps.refreshAccessToken()
      const res2 = await send(await deps.getAccessToken())
      if (!res2.ok) {
        log.error({ msg: 'gmail POST failed after refresh', status: res2.status, url })
        throw new Error(`gmail api ${res2.status}`)
      }
      return res2.json()
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
      const delayMs = BACKOFF_BASE_MS * 2 ** attempt
      log.warn({ msg: 'gmail retryable status (POST); backing off', status: res.status, attempt, delayMs, url })
      await new Promise((r) => setTimeout(r, delayMs))
      continue
    }
    if (!res.ok) {
      log.error({ msg: 'gmail POST non-ok', status: res.status, url })
      throw new Error(`gmail api ${res.status}`)
    }
    return res.json()
  }
}

export function createGmailApi(deps: GmailApiDeps): GmailApi {
  return {
    async getProfile() {
      log.debug({ msg: 'getProfile' })
      const j = (await getJson(`${BASE}/users/me/profile`, deps)) as { emailAddress?: string; historyId?: string }
      return { emailAddress: j.emailAddress ?? '', historyId: String(j.historyId ?? '') }
    },

    async listThreads(input) {
      const max = Math.min(input?.max ?? 50, MAX_PAGE)
      const label = input?.label ?? 'INBOX'
      const u = new URL(`${BASE}/users/me/threads`)
      u.searchParams.set('labelIds', label)
      u.searchParams.set('maxResults', String(max))
      if (input?.pageToken) u.searchParams.set('pageToken', input.pageToken)
      log.debug({ msg: 'listThreads', label, max, paged: !!input?.pageToken })
      const j = (await getJson(u.toString(), deps)) as {
        threads?: { id: string }[]
        nextPageToken?: string
      }
      const threadIds = (j.threads ?? []).map((t) => t.id)
      log.info({ msg: 'listThreads done', count: threadIds.length, more: !!j.nextPageToken })
      return { threadIds, nextPageToken: j.nextPageToken ?? null }
    },

    async getInboxTotal() {
      const j = (await getJson(`${BASE}/users/me/labels/INBOX`, deps)) as { threadsTotal?: number }
      return j.threadsTotal ?? 0
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
        const { text, html } = pickBodies(m.payload ?? {})
        return {
          id: m.id,
          threadId: m.threadId,
          fromAddr: from,
          toAddrs: to,
          subject: header(m.payload ?? {}, 'Subject'),
          snippet: m.snippet ?? '',
          bodyText: text,
          htmlBody: html,
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
      log.debug({ msg: 'fetchThread done', id, messageCount: messages.length })
      return { thread, messages }
    },

    async getHistory(startHistoryId) {
      const changedThreadIds = new Set<string>()
      const readThreadIds = new Set<string>()
      const unreadThreadIds = new Set<string>()
      let latest = startHistoryId
      let pageToken: string | undefined
      try {
        do {
          const u = new URL(`${BASE}/users/me/history`)
          u.searchParams.set('startHistoryId', startHistoryId)
          // New/deleted messages + label flips (UNREAD for read-state, INBOX/
          // TRASH for inbox membership).
          u.searchParams.append('historyTypes', 'messageAdded')
          u.searchParams.append('historyTypes', 'messageDeleted')
          u.searchParams.append('historyTypes', 'labelAdded')
          u.searchParams.append('historyTypes', 'labelRemoved')
          if (pageToken) u.searchParams.set('pageToken', pageToken)
          const j = (await getJson(u.toString(), deps)) as {
            historyId?: string
            nextPageToken?: string
            history?: Array<{
              messagesAdded?: { message: { threadId: string } }[]
              messagesDeleted?: { message: { threadId: string } }[]
              labelsAdded?: { message: { threadId: string }; labelIds?: string[] }[]
              labelsRemoved?: { message: { threadId: string }; labelIds?: string[] }[]
            }>
          }
          if (j.historyId) latest = j.historyId
          for (const h of j.history ?? []) {
            for (const m of h.messagesAdded ?? []) changedThreadIds.add(m.message.threadId)
            for (const m of h.messagesDeleted ?? []) changedThreadIds.add(m.message.threadId)
            for (const l of h.labelsRemoved ?? []) {
              // Left INBOX (archived, or moved to trash which also drops INBOX).
              if (l.labelIds?.includes('INBOX')) changedThreadIds.add(l.message.threadId)
              if (l.labelIds?.includes('UNREAD')) readThreadIds.add(l.message.threadId)
            }
            for (const l of h.labelsAdded ?? []) {
              if (l.labelIds?.includes('TRASH')) changedThreadIds.add(l.message.threadId)
              if (l.labelIds?.includes('UNREAD')) unreadThreadIds.add(l.message.threadId)
            }
          }
          pageToken = j.nextPageToken
        } while (pageToken)
      } catch (e) {
        // A too-old startHistoryId returns 404 — signal the caller to full-resync.
        if (String(e).includes('404')) {
          log.warn({ msg: 'gmail history cursor expired; full resync needed', startHistoryId })
          return { expired: true }
        }
        throw e
      }
      log.info({
        msg: 'getHistory done',
        changed: changedThreadIds.size,
        read: readThreadIds.size,
        unread: unreadThreadIds.size,
      })
      return {
        expired: false,
        changedThreadIds: [...changedThreadIds],
        readThreadIds: [...readThreadIds],
        unreadThreadIds: [...unreadThreadIds],
        newHistoryId: latest,
      }
    },

    async markThreadRead(id) {
      log.info({ msg: 'markThreadRead', id })
      await postJson(`${BASE}/users/me/threads/${id}/modify`, { removeLabelIds: ['UNREAD'] }, deps)
    },
  }
}
