// Bilibili login via an Electron BrowserWindow. Opens the passport login page,
// polls the window's session cookies until the three auth cookies appear, then
// persists them (encrypted) and validates via the nav endpoint.
import { createLogger } from '@shared/logger'
import type { BiliCredentials, BiliLoginStatus } from '@shared/types/bilibili'
import { BrowserWindow, session } from 'electron'

import { getNav } from './api'
import type { Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-auth' })

const LOGIN_URL = 'https://passport.bilibili.com/login'
const COOKIE_URL = 'https://www.bilibili.com'
const POLL_MS = 1000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export function extractCredentials(cookies: { name: string; value: string }[]): BiliCredentials | null {
  const byName = new Map(cookies.map((c) => [c.name, c.value]))
  const sessdata = byName.get('SESSDATA')
  const biliJct = byName.get('bili_jct')
  const dedeUserId = byName.get('DedeUserID')
  if (!sessdata || !biliJct || !dedeUserId) return null
  return { sessdata, biliJct, dedeUserId }
}

export type Auth = {
  login(): Promise<BiliLoginStatus>
  status(): Promise<BiliLoginStatus>
  logout(): Promise<void>
}

export function createAuth(opts: { store: Store }): Auth {
  const { store } = opts

  const status: Auth['status'] = async () => {
    const cfg = await store.load()
    if (!cfg.credentials) return { loggedIn: false, uname: null, mid: null }
    try {
      return await getNav(cfg.credentials)
    } catch (err) {
      log.warn({ msg: 'nav check failed, treating as logged-out', err: err instanceof Error ? err.message : String(err) })
      return { loggedIn: false, uname: null, mid: null }
    }
  }

  const login: Auth['login'] = () =>
    new Promise<BiliLoginStatus>((resolve, reject) => {
      log.info({ msg: 'bilibili login window opening' })
      const win = new BrowserWindow({
        width: 480,
        height: 640,
        autoHideMenuBar: true,
        title: 'Bilibili 登录',
        webPreferences: { partition: 'persist:bilibili' },
      })

      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearInterval(timer)
        clearTimeout(deadline)
        if (!win.isDestroyed()) win.close()
        fn()
      }

      const ses = session.fromPartition('persist:bilibili')
      const timer = setInterval(async () => {
        try {
          const cookies = await ses.cookies.get({ url: COOKIE_URL })
          const creds = extractCredentials(cookies)
          if (!creds) return
          await store.save({ credentials: creds })
          const st = await getNav(creds)
          log.info({ msg: 'bilibili login captured', loggedIn: st.loggedIn, mid: st.mid })
          finish(() => resolve(st))
        } catch (err) {
          log.error({ msg: 'login cookie poll failed', err: err instanceof Error ? err.message : String(err) })
        }
      }, POLL_MS)

      const deadline = setTimeout(() => {
        log.warn({ msg: 'bilibili login timed out' })
        finish(() => reject(new Error('login timed out')))
      }, LOGIN_TIMEOUT_MS)

      win.on('closed', () => finish(() => reject(new Error('login window closed'))))
      win.loadURL(LOGIN_URL)
    })

  const logout: Auth['logout'] = async () => {
    await store.save({ credentials: null })
    const ses = session.fromPartition('persist:bilibili')
    await ses.clearStorageData()
    log.info({ msg: 'bilibili logged out' })
  }

  return { login, status, logout }
}
