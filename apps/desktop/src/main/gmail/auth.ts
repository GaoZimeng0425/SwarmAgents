// src/main/gmail/auth.ts
//
// Gmail OAuth via a loopback HTTP server (Google's installed-app flow). Opens
// the consent URL in the system browser; the loopback server captures the
// ?code= redirect, exchanges it for tokens, and persists them (encrypted).
// Token refresh runs on-demand when getAccessToken sees an expired token.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createLogger } from '@shared/logger'
import type { GmailClientCreds, GmailConfigOnDisk, GmailTokens } from '@shared/types/gmail'
import { shell } from 'electron'

import type { Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'gmail-auth' })

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const CONSENT_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export type CodeExchangeResult = { accessToken: string; refreshToken: string; expiresAt: number }

export function extractCode(callbackPath: string): string | null {
  try {
    const idx = callbackPath.indexOf('?')
    const qs = new URLSearchParams(idx >= 0 ? callbackPath.slice(idx + 1) : callbackPath)
    return qs.get('code')
  } catch {
    return null
  }
}

export async function exchangeCode(input: {
  creds: GmailClientCreds
  code: string
  redirectUri: string
}): Promise<CodeExchangeResult> {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.creds.clientId,
    client_secret: input.creds.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  })
  const res = await fetch(TOKEN_ENDPOINT, { method: 'POST', body })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`token exchange failed: ${res.status} ${t}`)
  }
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number }
  if (!j.refresh_token) throw new Error('no refresh_token returned (re-link with prompt=consent)')
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: Date.now() + j.expires_in * 1000,
  }
}

export async function refreshTokens(input: {
  creds: GmailClientCreds
  refreshToken: string
}): Promise<{ accessToken: string; expiresAt: number }> {
  const body = new URLSearchParams({
    refresh_token: input.refreshToken,
    client_id: input.creds.clientId,
    client_secret: input.creds.clientSecret,
    grant_type: 'refresh_token',
  })
  const res = await fetch(TOKEN_ENDPOINT, { method: 'POST', body })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`refresh failed: ${res.status} ${t}`)
  }
  const j = (await res.json()) as { access_token: string; expires_in: number }
  return { accessToken: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 }
}

export type Auth = {
  login(): Promise<void>
  logout(): Promise<void>
  getAccessToken(): Promise<string>
  refreshAccessToken(): Promise<void>
}

export type AuthDeps = {
  store: Store
  /** Fetch the Gmail profile once tokens land; returns { emailAddress }. */
  onProfile: (token: string) => Promise<{ emailAddress: string }>
}

export function createAuth(deps: AuthDeps): Auth {
  const { store } = deps

  const persistTokens = async (next: GmailTokens, email?: string): Promise<void> => {
    const cur = await store.load()
    const state: GmailConfigOnDisk = {
      clientCreds: cur.clientCreds,
      tokens: next,
      accountEmail: email ?? cur.accountEmail,
    }
    await store.save(state)
  }

  const getAccessToken: Auth['getAccessToken'] = async () => {
    const cfg = await store.load()
    if (!cfg.tokens) throw new Error('Gmail not linked')
    const skew = 60_000
    if (cfg.tokens.expiresAt - skew > Date.now()) return cfg.tokens.accessToken
    await refreshAccessToken()
    const after = await store.load()
    if (!after.tokens) throw new Error('Gmail not linked after refresh')
    return after.tokens.accessToken
  }

  const refreshAccessToken: Auth['refreshAccessToken'] = async () => {
    const cfg = await store.load()
    if (!cfg.clientCreds || !cfg.tokens) throw new Error('Gmail not linked')
    log.info({ msg: 'refreshing gmail access token' })
    const r = await refreshTokens({ creds: cfg.clientCreds, refreshToken: cfg.tokens.refreshToken })
    await persistTokens({ refreshToken: cfg.tokens.refreshToken, ...r })
  }

  const login: Auth['login'] = () =>
    new Promise<void>((resolve, reject) => {
      store.load().then((cfg) => {
        if (!cfg.clientCreds) {
          reject(new Error('missing OAuth client credentials'))
          return
        }
        const creds = cfg.clientCreds
        let server: Server | null = null
        let settled = false
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(deadline)
          server?.close()
          fn()
        }
        const deadline = setTimeout(() => {
          log.warn({ msg: 'gmail login timed out' })
          finish(() => reject(new Error('login timed out')))
        }, LOGIN_TIMEOUT_MS)

        server = createServer(async (req, res) => {
          const url = req.url ?? '/'
          const code = extractCode(url)
          if (!code) {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('Missing code parameter.')
            return
          }
          try {
            const tokens = await exchangeCode({ creds, code, redirectUri: redirectUriHeld! })
            const profile = await deps.onProfile(tokens.accessToken)
            await persistTokens(tokens, profile.emailAddress)
            log.info({ msg: 'gmail login captured', email: profile.emailAddress })
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('Linked. You can close this tab.')
            finish(() => resolve())
          } catch (err) {
            log.error({ msg: 'gmail login exchange failed', err: err instanceof Error ? err.message : String(err) })
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('Link failed. Check the app.')
            finish(() => reject(err instanceof Error ? err : new Error(String(err))))
          }
        })
        server.on('error', (err) => finish(() => reject(err)))
        // Hold the redirect URI so the handler closes over the actual port.
        let redirectUriHeld: string | null = null
        server.listen(0, '127.0.0.1', () => {
          const port = (server!.address() as AddressInfo).port
          redirectUriHeld = `http://127.0.0.1:${port}`
          const u = new URL(CONSENT_URL)
          u.searchParams.set('client_id', creds.clientId)
          u.searchParams.set('redirect_uri', redirectUriHeld)
          u.searchParams.set('response_type', 'code')
          u.searchParams.set('scope', SCOPE)
          u.searchParams.set('access_type', 'offline')
          u.searchParams.set('prompt', 'consent')
          log.info({ msg: 'gmail consent opening', redirectUri: redirectUriHeld })
          void shell.openExternal(u.toString())
        })
      })
    })

  const logout: Auth['logout'] = async () => {
    const cur = await store.load()
    await store.save({ ...cur, tokens: null, accountEmail: null })
    log.info({ msg: 'gmail logged out' })
  }

  return { login, logout, getAccessToken, refreshAccessToken }
}
