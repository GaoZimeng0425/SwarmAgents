# Bilibili 里程碑 A：登录鉴权 + 列表展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户能在应用内登录 Bilibili，并看到自己的收藏夹与稍后再看视频列表。

**Architecture:** 新增 `src/main/bilibili/` 主进程模块，沿用现有 `trending` 的分层（service/ipc/index）与 `web-search` 的加密 store 模式。登录用 Electron `BrowserWindow` 打开 B 站登录页，从该窗口 session 的 cookies 抽取 `SESSDATA`/`bili_jct`/`DedeUserID` 持久化（safeStorage 加密）。列表通过带 Cookie 头的 `fetch` 调 B 站公开 JSON 接口。渲染层新增独立视图，结构对齐 `trending-view`。

**Tech Stack:** Electron 42, TypeScript, React, Zod, Electron `safeStorage`，Vitest（经 `npm test` 即 Electron-as-node 运行）。

## Global Constraints

- 语言：对话用中文；**代码注释与 commit message 一律英文**（CLAUDE.md §0）。
- 日志：用 `createLogger({ process: 'main' }).child({ component: '<module>' })`；业务入口/出口 `info`，每个 `catch` `error`，分支意外 `warn`（CLAUDE.md §5）。
- 测试运行：`npm test`（= `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`）。**不要**用裸 `npx vitest`，**不要** `pnpm rebuild better-sqlite3`。
- 路径：本会话在 worktree `.claude/worktrees/bilibili-obsidian` 内，用 worktree 相对路径写文件，commit 前 `git status` 确认未落到主 checkout。
- 风控：所有 B 站请求必须带 `User-Agent`（桌面 Chrome UA）与 `Referer: https://www.bilibili.com`，否则触发 -412 风控。
- 凭证敏感：cookies 经 `safeStorage` 加密落盘，绝不明文写日志（沿用 web-search store 模式）。
- 编码风格：匹配现有文件（2 空格缩进、无分号风格按 biome 配置、`@shared/*` 别名）。

---

## 共享常量（多个任务引用）

桌面 UA（任务 4、3 都会用，集中定义于 `api.ts` 并导出）：

```ts
export const BILI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
export const BILI_REFERER = 'https://www.bilibili.com'
```

B 站接口地址：
- 登录态 + mid：`https://api.bilibili.com/x/web-interface/nav`
- 收藏夹列表：`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid={mid}`
- 收藏夹内容：`https://api.bilibili.com/x/v3/fav/resource/list?media_id={id}&ps=20&pn={pn}&platform=web`
- 稍后再看：`https://api.bilibili.com/x/v2/history/toview`
- 登录页：`https://passport.bilibili.com/login`

---

## File Structure

- Create `src/shared/types/bilibili.ts` — 共享类型与 zod schema
- Create `src/main/bilibili/store.ts` — 加密配置 store（仅存 credentials）
- Create `src/main/bilibili/api.ts` — UA/Referer 常量 + cookie 注入 + nav/收藏夹/稍后再看 fetch
- Create `src/main/bilibili/auth.ts` — 登录窗口 + cookie 抽取 + 登录态校验
- Create `src/main/bilibili/ipc.ts` — IPC 端点
- Create `src/main/bilibili/index.ts` — 装配
- Modify `src/main/index.ts` — 调 `initBilibili()`
- Modify `src/preload/index.ts` — 新增 `bilibili` 桥
- Modify `src/shared/types/ui.ts` — 新增 `BilibiliBridge` 类型并挂到 window API 类型
- Create `src/renderer/src/components/views/bilibili-view.tsx` — 列表视图
- Create `src/renderer/src/routes/bilibili.tsx` — 路由
- Test 文件与各源文件同级：`*.test.ts`

---

### Task 1: 共享类型与 schema

**Files:**
- Create: `src/shared/types/bilibili.ts`
- Test: `src/shared/types/bilibili.test.ts`

**Interfaces:**
- Produces:
  - `type BiliCredentials = { sessdata: string; biliJct: string; dedeUserId: string }`
  - `type BiliVideo = { bvid: string; title: string; cover: string; author: string; durationSec: number; intro: string; source: string }`
  - `type BiliFavFolder = { id: number; title: string; count: number }`
  - `type BiliLoginStatus = { loggedIn: boolean; uname: string | null; mid: number | null }`
  - `const BilibiliConfigOnDisk` (zod) 与 `type BilibiliConfigOnDisk`
  - `function defaultBilibiliConfigOnDisk(): BilibiliConfigOnDisk`

- [ ] **Step 1: 写失败测试**

```ts
// src/shared/types/bilibili.test.ts
import { describe, expect, it } from 'vitest'
import { BilibiliConfigOnDisk, defaultBilibiliConfigOnDisk } from './bilibili'

describe('BilibiliConfigOnDisk', () => {
  it('defaults to null credentials', () => {
    expect(defaultBilibiliConfigOnDisk()).toEqual({ credentials: null })
  })

  it('accepts a valid credentials object', () => {
    const r = BilibiliConfigOnDisk.safeParse({
      credentials: { sessdata: 'a', biliJct: 'b', dedeUserId: '123' },
    })
    expect(r.success).toBe(true)
  })

  it('rejects unknown top-level keys', () => {
    const r = BilibiliConfigOnDisk.safeParse({ credentials: null, extra: 1 })
    expect(r.success).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/shared/types/bilibili.test.ts`
Expected: FAIL（`Cannot find module './bilibili'`）

- [ ] **Step 3: 实现类型**

```ts
// src/shared/types/bilibili.ts
//
// Shared types for the Bilibili integration: credentials, list items, and the
// encrypted on-disk config schema. Mirrors fields we read from Bilibili's
// public web API.
import { z } from 'zod'

export type BiliCredentials = {
  sessdata: string
  biliJct: string
  dedeUserId: string
}

// A favorites-folder or watch-later video, normalized for the UI.
export type BiliVideo = {
  bvid: string
  title: string
  cover: string
  author: string
  durationSec: number
  intro: string
  source: string
}

export type BiliFavFolder = {
  id: number
  title: string
  count: number
}

export type BiliLoginStatus = {
  loggedIn: boolean
  uname: string | null
  mid: number | null
}

export const BiliCredentialsSchema = z
  .object({
    sessdata: z.string(),
    biliJct: z.string(),
    dedeUserId: z.string(),
  })
  .strict()

export const BilibiliConfigOnDisk = z
  .object({
    credentials: BiliCredentialsSchema.nullable(),
  })
  .strict()

export type BilibiliConfigOnDisk = z.infer<typeof BilibiliConfigOnDisk>

export function defaultBilibiliConfigOnDisk(): BilibiliConfigOnDisk {
  return { credentials: null }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/shared/types/bilibili.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 5: commit**

```bash
git add src/shared/types/bilibili.ts src/shared/types/bilibili.test.ts
git commit -m "feat(bilibili): shared types and on-disk config schema"
```

---

### Task 2: 加密配置 store

**Files:**
- Create: `src/main/bilibili/store.ts`
- Test: `src/main/bilibili/store.test.ts`

**Interfaces:**
- Consumes: `BilibiliConfigOnDisk`, `defaultBilibiliConfigOnDisk`（Task 1）
- Produces:
  - `type Store = { load(): Promise<BilibiliConfigOnDisk>; save(state: BilibiliConfigOnDisk): Promise<void> }`
  - `function createStore(opts: { filePath: string }): Store`

参照 `src/main/web-search/store.ts`：safeStorage 加密、原子写（tmp→rename）、保存前 zod 校验。测试需 mock `electron` 的 `safeStorage`。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/bilibili/store.test.ts
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// safeStorage isn't available under ELECTRON_RUN_AS_NODE; stub it with a
// reversible base64 "cipher" so the store's encrypt/decrypt path is exercised.
vi.mock('electron', () => ({
  safeStorage: {
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}))

import { createStore } from './store'

let dir: string
let filePath: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'bili-store-'))
  filePath = join(dir, 'bilibili.bin')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('bilibili store', () => {
  it('returns defaults when file is missing', async () => {
    const store = createStore({ filePath })
    expect(await store.load()).toEqual({ credentials: null })
  })

  it('round-trips saved credentials', async () => {
    const store = createStore({ filePath })
    await store.save({ credentials: { sessdata: 's', biliJct: 'j', dedeUserId: '1' } })
    expect(await store.load()).toEqual({
      credentials: { sessdata: 's', biliJct: 'j', dedeUserId: '1' },
    })
  })

  it('returns defaults when stored bytes are not valid', async () => {
    await fs.writeFile(filePath, Buffer.from('not json', 'utf8'))
    const store = createStore({ filePath })
    expect(await store.load()).toEqual({ credentials: null })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/main/bilibili/store.test.ts`
Expected: FAIL（`Cannot find module './store'`）

- [ ] **Step 3: 实现 store**

```ts
// src/main/bilibili/store.ts
//
// Encrypted on-disk Bilibili config store. Same shape as web-search/store.ts:
// single file via Electron safeStorage, atomic writes (tmp -> rename), validated
// against the Zod schema before encryption. Pure module: no logging, no globals.
import { existsSync, promises as fs } from 'node:fs'
import { BilibiliConfigOnDisk, defaultBilibiliConfigOnDisk } from '@shared/types/bilibili'
import { safeStorage } from 'electron'

export type Store = {
  load(): Promise<BilibiliConfigOnDisk>
  save(state: BilibiliConfigOnDisk): Promise<void>
}

export function createStore(opts: { filePath: string }): Store {
  const { filePath } = opts

  const load: Store['load'] = async () => {
    if (!existsSync(filePath)) return defaultBilibiliConfigOnDisk()
    try {
      const buf = await fs.readFile(filePath)
      const json = safeStorage.decryptString(buf)
      const parsed = JSON.parse(json)
      const checked = BilibiliConfigOnDisk.safeParse(parsed)
      return checked.success ? checked.data : defaultBilibiliConfigOnDisk()
    } catch {
      return defaultBilibiliConfigOnDisk()
    }
  }

  let saveQueue: Promise<void> = Promise.resolve()
  const save: Store['save'] = (state) => {
    const next = saveQueue.then(async () => {
      BilibiliConfigOnDisk.parse(state)
      const ciphertext = safeStorage.encryptString(JSON.stringify(state))
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, ciphertext)
      await fs.rename(tmp, filePath)
    })
    saveQueue = next.catch(() => undefined)
    return next
  }

  return { load, save }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/main/bilibili/store.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 5: commit**

```bash
git add src/main/bilibili/store.ts src/main/bilibili/store.test.ts
git commit -m "feat(bilibili): encrypted on-disk config store"
```

---

### Task 3: API 客户端（nav / 收藏夹 / 稍后再看）

**Files:**
- Create: `src/main/bilibili/api.ts`
- Test: `src/main/bilibili/api.test.ts`

**Interfaces:**
- Consumes: `BiliCredentials`, `BiliVideo`, `BiliFavFolder`, `BiliLoginStatus`（Task 1）
- Produces:
  - `const BILI_UA: string`, `const BILI_REFERER: string`
  - `function cookieHeader(c: BiliCredentials): string`
  - `function getNav(c: BiliCredentials): Promise<BiliLoginStatus>`
  - `function getFavFolders(c: BiliCredentials, mid: number): Promise<BiliFavFolder[]>`
  - `function getFavResources(c: BiliCredentials, mediaId: number, folderTitle: string): Promise<BiliVideo[]>`
  - `function getWatchLater(c: BiliCredentials): Promise<BiliVideo[]>`

测试通过 `vi.stubGlobal('fetch', ...)` mock。注意：B 站接口外层是 `{ code, message, data }`，`code !== 0` 视为错误。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/bilibili/api.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cookieHeader, getFavFolders, getNav, getWatchLater } from './api'

const creds = { sessdata: 's', biliJct: 'j', dedeUserId: '42' }

afterEach(() => vi.unstubAllGlobals())

function mockJson(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  )
}

describe('cookieHeader', () => {
  it('serializes the three required cookies', () => {
    expect(cookieHeader(creds)).toBe('SESSDATA=s; bili_jct=j; DedeUserID=42')
  })
})

describe('getNav', () => {
  it('maps logged-in nav payload', async () => {
    mockJson({ code: 0, data: { isLogin: true, uname: 'me', mid: 42 } })
    expect(await getNav(creds)).toEqual({ loggedIn: true, uname: 'me', mid: 42 })
  })

  it('reports logged-out when code is -101', async () => {
    mockJson({ code: -101, message: 'not logged in', data: { isLogin: false } })
    expect(await getNav(creds)).toEqual({ loggedIn: false, uname: null, mid: null })
  })
})

describe('getFavFolders', () => {
  it('maps folder list', async () => {
    mockJson({ code: 0, data: { list: [{ id: 99, title: 'CS', media_count: 7 }] } })
    expect(await getFavFolders(creds, 42)).toEqual([{ id: 99, title: 'CS', count: 7 }])
  })

  it('returns [] when data.list is null', async () => {
    mockJson({ code: 0, data: { list: null } })
    expect(await getFavFolders(creds, 42)).toEqual([])
  })

  it('throws on non-zero code', async () => {
    mockJson({ code: -400, message: 'bad request' })
    await expect(getFavFolders(creds, 42)).rejects.toThrow(/-400/)
  })
})

describe('getWatchLater', () => {
  it('maps toview list to BiliVideo', async () => {
    mockJson({
      code: 0,
      data: {
        list: [
          {
            bvid: 'BV1',
            title: 'T',
            pic: 'http://img',
            duration: 600,
            owner: { name: 'up' },
            desc: 'hello',
          },
        ],
      },
    })
    expect(await getWatchLater(creds)).toEqual([
      {
        bvid: 'BV1',
        title: 'T',
        cover: 'http://img',
        author: 'up',
        durationSec: 600,
        intro: 'hello',
        source: '稍后再看',
      },
    ])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/main/bilibili/api.test.ts`
Expected: FAIL（`Cannot find module './api'`）

- [ ] **Step 3: 实现 api**

```ts
// src/main/bilibili/api.ts
//
// Bilibili public web-API client. Injects the user's cookies plus a desktop
// UA + Referer (required to avoid -412 风控). All endpoints wrap responses as
// { code, message, data }; a non-zero code is an error.
import type { BiliCredentials, BiliFavFolder, BiliLoginStatus, BiliVideo } from '@shared/types/bilibili'

export const BILI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
export const BILI_REFERER = 'https://www.bilibili.com'

const TIMEOUT_MS = 10_000

export function cookieHeader(c: BiliCredentials): string {
  return `SESSDATA=${c.sessdata}; bili_jct=${c.biliJct}; DedeUserID=${c.dedeUserId}`
}

type Envelope<T> = { code: number; message?: string; data?: T }

async function get<T>(url: string, c: BiliCredentials): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      cookie: cookieHeader(c),
      'user-agent': BILI_UA,
      referer: BILI_REFERER,
    },
  })
  if (!res.ok) throw new Error(`Bilibili HTTP ${res.status} ${res.statusText} for ${url}`)
  const body = (await res.json()) as Envelope<T>
  if (body.code !== 0) throw new Error(`Bilibili API code ${body.code}: ${body.message ?? 'unknown'}`)
  return body.data as T
}

type NavData = { isLogin?: boolean; uname?: string; mid?: number }

export async function getNav(c: BiliCredentials): Promise<BiliLoginStatus> {
  // nav returns code -101 when the cookie is invalid/expired; treat as logged-out
  // rather than throwing, so the UI can prompt re-login.
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { cookie: cookieHeader(c), 'user-agent': BILI_UA, referer: BILI_REFERER },
  })
  const body = (await res.json()) as Envelope<NavData>
  if (body.code !== 0 || !body.data?.isLogin) {
    return { loggedIn: false, uname: null, mid: null }
  }
  return { loggedIn: true, uname: body.data.uname ?? null, mid: body.data.mid ?? null }
}

type FavFolderRow = { id: number; title: string; media_count: number }

export async function getFavFolders(c: BiliCredentials, mid: number): Promise<BiliFavFolder[]> {
  const url = `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(String(mid))}`
  const data = await get<{ list: FavFolderRow[] | null }>(url, c)
  const list = data.list ?? []
  return list.map((f) => ({ id: f.id, title: f.title, count: f.media_count }))
}

type FavMediaRow = {
  bvid: string
  title: string
  cover: string
  duration: number
  intro?: string
  upper?: { name?: string }
}

export async function getFavResources(c: BiliCredentials, mediaId: number, folderTitle: string): Promise<BiliVideo[]> {
  const url = `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${encodeURIComponent(String(mediaId))}&ps=20&pn=1&platform=web`
  const data = await get<{ medias: FavMediaRow[] | null }>(url, c)
  const medias = data.medias ?? []
  return medias.map((m) => ({
    bvid: m.bvid,
    title: m.title,
    cover: m.cover,
    author: m.upper?.name ?? '',
    durationSec: m.duration,
    intro: m.intro ?? '',
    source: folderTitle,
  }))
}

type ToViewRow = {
  bvid: string
  title: string
  pic: string
  duration: number
  desc?: string
  owner?: { name?: string }
}

export async function getWatchLater(c: BiliCredentials): Promise<BiliVideo[]> {
  const data = await get<{ list: ToViewRow[] | null }>('https://api.bilibili.com/x/v2/history/toview', c)
  const list = data.list ?? []
  return list.map((v) => ({
    bvid: v.bvid,
    title: v.title,
    cover: v.pic,
    author: v.owner?.name ?? '',
    durationSec: v.duration,
    intro: v.desc ?? '',
    source: '稍后再看',
  }))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/main/bilibili/api.test.ts`
Expected: PASS（全部 passed）

- [ ] **Step 5: commit**

```bash
git add src/main/bilibili/api.ts src/main/bilibili/api.test.ts
git commit -m "feat(bilibili): public web-API client for nav/favorites/watch-later"
```

---

### Task 4: 登录窗口与 cookie 抽取

**Files:**
- Create: `src/main/bilibili/auth.ts`
- Test: `src/main/bilibili/auth.test.ts`

**Interfaces:**
- Consumes: `BiliCredentials`（Task 1）；`getNav`（Task 3）；`Store`（Task 2）
- Produces:
  - `function extractCredentials(cookies: { name: string; value: string }[]): BiliCredentials | null` — 纯函数，从 cookie 数组抽三件套（缺任一返回 null）
  - `function createAuth(opts: { store: Store }): Auth`
  - `type Auth = { login(): Promise<BiliLoginStatus>; status(): Promise<BiliLoginStatus>; logout(): Promise<void> }`

`login()`：开 `BrowserWindow` 到登录页；监听到 cookie 齐全后从 session 读 cookies、抽凭证、存盘、关窗口、调 `getNav` 返回状态。窗口/electron 部分手动冒烟；**`extractCredentials` 这一纯函数做单测**（它是凭证抽取的正确性核心）。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/bilibili/auth.test.ts
import { describe, expect, it } from 'vitest'
import { extractCredentials } from './auth'

describe('extractCredentials', () => {
  it('pulls the three required cookies', () => {
    expect(
      extractCredentials([
        { name: 'SESSDATA', value: 'sess' },
        { name: 'bili_jct', value: 'jct' },
        { name: 'DedeUserID', value: '42' },
        { name: 'other', value: 'x' },
      ])
    ).toEqual({ sessdata: 'sess', biliJct: 'jct', dedeUserId: '42' })
  })

  it('returns null when SESSDATA is missing', () => {
    expect(
      extractCredentials([
        { name: 'bili_jct', value: 'jct' },
        { name: 'DedeUserID', value: '42' },
      ])
    ).toBeNull()
  })

  it('returns null for an empty cookie list', () => {
    expect(extractCredentials([])).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/main/bilibili/auth.test.ts`
Expected: FAIL（`Cannot find module './auth'`）

- [ ] **Step 3: 实现 auth**

```ts
// src/main/bilibili/auth.ts
//
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/main/bilibili/auth.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 5: commit**

```bash
git add src/main/bilibili/auth.ts src/main/bilibili/auth.test.ts
git commit -m "feat(bilibili): login window and credential extraction"
```

---

### Task 5: IPC + 模块装配 + main 接线

**Files:**
- Create: `src/main/bilibili/ipc.ts`
- Create: `src/main/bilibili/index.ts`
- Modify: `src/main/index.ts`（import + 在其它 init 之后调用 `initBilibili()`）
- Test: `src/main/bilibili/ipc.test.ts`

**Interfaces:**
- Consumes: `createAuth`/`Auth`（Task 4）；`createStore`（Task 2）；`getFavFolders`/`getFavResources`/`getWatchLater`（Task 3）；`paths`（`src/main/constants.ts`，新增 `paths.bilibili()`）
- Produces:
  - IPC 通道：`bilibili:status`、`bilibili:login`、`bilibili:logout`、`bilibili:list`
  - `bilibili:list` 返回 `{ folders: { folder: BiliFavFolder; videos: BiliVideo[] }[]; watchLater: BiliVideo[] }`（类型名 `BiliListResult`，加到 `src/shared/types/bilibili.ts` 并导出）
  - `function initBilibili(): { dispose(): void }`

先给 `src/shared/types/bilibili.ts` 补一个返回类型（小改，随本任务提交）：

```ts
export type BiliListResult = {
  folders: { folder: BiliFavFolder; videos: BiliVideo[] }[]
  watchLater: BiliVideo[]
}
```

`src/main/constants.ts` 的 `paths` 对象里按现有写法补一行（与 `providers()` 同级）：

```ts
bilibili: () => join(swarmDir(), 'bilibili.bin'),
```
> 实现时打开 `src/main/constants.ts` 照搬 `providers()` 那一行的确切写法（同样的 `swarmDir()`/`join` 用法）。

- [ ] **Step 1: 写失败测试（list 聚合逻辑）**

`buildList` 是把 nav→folders→各夹内容→稍后再看 聚合起来的纯逻辑，单独导出做单测（注入依赖，mock 掉网络函数）。

```ts
// src/main/bilibili/ipc.test.ts
import { describe, expect, it, vi } from 'vitest'
import { buildList } from './ipc'

const creds = { sessdata: 's', biliJct: 'j', dedeUserId: '42' }
const vid = (bvid: string, source: string) => ({
  bvid, title: bvid, cover: '', author: 'up', durationSec: 1, intro: '', source,
})

describe('buildList', () => {
  it('aggregates folders, their videos, and watch-later', async () => {
    const deps = {
      getFavFolders: vi.fn(async () => [{ id: 99, title: 'CS', count: 1 }]),
      getFavResources: vi.fn(async () => [vid('BV1', 'CS')]),
      getWatchLater: vi.fn(async () => [vid('BV2', '稍后再看')]),
    }
    const result = await buildList(creds, 42, deps)
    expect(result.folders).toEqual([{ folder: { id: 99, title: 'CS', count: 1 }, videos: [vid('BV1', 'CS')] }])
    expect(result.watchLater).toEqual([vid('BV2', '稍后再看')])
    expect(deps.getFavResources).toHaveBeenCalledWith(creds, 99, 'CS')
  })

  it('tolerates a single folder failing without dropping the rest', async () => {
    const deps = {
      getFavFolders: vi.fn(async () => [
        { id: 1, title: 'A', count: 1 },
        { id: 2, title: 'B', count: 1 },
      ]),
      getFavResources: vi.fn(async (_c, id: number) => {
        if (id === 1) throw new Error('boom')
        return [vid('BV2', 'B')]
      }),
      getWatchLater: vi.fn(async () => []),
    }
    const result = await buildList(creds, 42, deps)
    expect(result.folders).toEqual([
      { folder: { id: 1, title: 'A', count: 1 }, videos: [] },
      { folder: { id: 2, title: 'B', count: 1 }, videos: [vid('BV2', 'B')] },
    ])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/main/bilibili/ipc.test.ts`
Expected: FAIL（`Cannot find module './ipc'`）

- [ ] **Step 3: 实现 ipc.ts**

```ts
// src/main/bilibili/ipc.ts
//
// Wires the Bilibili subsystem to Electron IPC: login/logout/status and a single
// aggregated list endpoint. buildList is exported for unit testing.
import { createLogger } from '@shared/logger'
import type { BiliCredentials, BiliListResult, BiliVideo, BiliFavFolder } from '@shared/types/bilibili'
import { ipcMain } from 'electron'

import { getFavFolders, getFavResources, getWatchLater } from './api'
import type { Auth } from './auth'
import type { Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-ipc' })

export type ListDeps = {
  getFavFolders: (c: BiliCredentials, mid: number) => Promise<BiliFavFolder[]>
  getFavResources: (c: BiliCredentials, mediaId: number, folderTitle: string) => Promise<BiliVideo[]>
  getWatchLater: (c: BiliCredentials) => Promise<BiliVideo[]>
}

export async function buildList(c: BiliCredentials, mid: number, deps: ListDeps): Promise<BiliListResult> {
  const folders = await deps.getFavFolders(c, mid)
  const withVideos = await Promise.all(
    folders.map(async (folder) => {
      try {
        const videos = await deps.getFavResources(c, folder.id, folder.title)
        return { folder, videos }
      } catch (err) {
        log.warn({ msg: 'fav folder load failed', folderId: folder.id, err: err instanceof Error ? err.message : String(err) })
        return { folder, videos: [] as BiliVideo[] }
      }
    })
  )
  let watchLater: BiliVideo[] = []
  try {
    watchLater = await deps.getWatchLater(c)
  } catch (err) {
    log.warn({ msg: 'watch-later load failed', err: err instanceof Error ? err.message : String(err) })
  }
  return { folders: withVideos, watchLater }
}

export function wireBilibiliIpc(opts: { auth: Auth; store: Store }): { dispose: () => void } {
  const { auth, store } = opts
  const deps: ListDeps = { getFavFolders, getFavResources, getWatchLater }

  ipcMain.handle('bilibili:status', () => auth.status())
  ipcMain.handle('bilibili:login', () => auth.login())
  ipcMain.handle('bilibili:logout', () => auth.logout())
  ipcMain.handle('bilibili:list', async (): Promise<BiliListResult> => {
    const started = Date.now()
    const st = await auth.status()
    if (!st.loggedIn || st.mid === null) {
      log.warn({ msg: 'bilibili:list called while logged out' })
      return { folders: [], watchLater: [] }
    }
    const cfg = await store.load()
    if (!cfg.credentials) return { folders: [], watchLater: [] }
    log.info({ msg: 'bilibili list started', mid: st.mid })
    const result = await buildList(cfg.credentials, st.mid, deps)
    log.info({
      msg: 'bilibili list ok',
      folders: result.folders.length,
      watchLater: result.watchLater.length,
      durationMs: Date.now() - started,
    })
    return result
  })

  log.info({ msg: 'bilibili IPC wired' })
  return {
    dispose(): void {
      for (const ch of ['bilibili:status', 'bilibili:login', 'bilibili:logout', 'bilibili:list']) {
        ipcMain.removeHandler(ch)
      }
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/main/bilibili/ipc.test.ts`
Expected: PASS（2 passed）

- [ ] **Step 5: 实现 index.ts 并接线 main**

```ts
// src/main/bilibili/index.ts
//
// Entry point for the Bilibili subsystem. Wires the encrypted store, auth, and IPC.
import { paths } from '../constants'
import { createAuth } from './auth'
import { wireBilibiliIpc } from './ipc'
import { createStore } from './store'

export type BilibiliHandle = { dispose(): void }

export function initBilibili(): BilibiliHandle {
  const store = createStore({ filePath: paths.bilibili() })
  const auth = createAuth({ store })
  const { dispose } = wireBilibiliIpc({ auth, store })
  return { dispose }
}
```

在 `src/main/index.ts`：仿照 `import { initTrending } from './trending'` 加 `import { initBilibili } from './bilibili'`；仿照 `const trending = initTrending()` 那一行其后加 `const bilibili = initBilibili()`。同时给 `src/main/constants.ts` 的 `paths` 加 `bilibili()`（见 Interfaces）。

- [ ] **Step 6: typecheck + 全量测试**

Run: `npm run typecheck && npm test -- src/main/bilibili`
Expected: typecheck 通过；bilibili 目录测试全 PASS

- [ ] **Step 7: commit**

```bash
git add src/main/bilibili/ipc.ts src/main/bilibili/index.ts src/main/bilibili/ipc.test.ts src/main/index.ts src/main/constants.ts src/shared/types/bilibili.ts
git commit -m "feat(bilibili): IPC endpoints, module assembly, main wiring"
```

---

### Task 6: preload 桥 + UI 类型

**Files:**
- Modify: `src/preload/index.ts`（新增 `bilibili` 桥并 `contextBridge.exposeInMainWorld` 挂载）
- Modify: `src/shared/types/ui.ts`（新增 `BilibiliBridge` 类型，挂到暴露给 window 的总 API 类型上）

**Interfaces:**
- Consumes: `BiliListResult`, `BiliLoginStatus`（Task 1/5）
- Produces（renderer 可用）：
  - `window.api.bilibili.status(): Promise<BiliLoginStatus>`
  - `window.api.bilibili.login(): Promise<BiliLoginStatus>`
  - `window.api.bilibili.logout(): Promise<void>`
  - `window.api.bilibili.list(): Promise<BiliListResult>`

> 实现前先在 `src/preload/index.ts` 找到其它桥（如 `providers`/`webSearch`）是如何定义并最终通过 `contextBridge.exposeInMainWorld` 暴露的，照搬同样结构。`src/shared/types/ui.ts` 中找到聚合所有 bridge 的总类型（window API 类型），把 `bilibili: BilibiliBridge` 加进去。

- [ ] **Step 1: 在 `src/shared/types/ui.ts` 新增类型**

```ts
// 引入（与文件顶部其它 @shared/types 引入并列）
import type { BiliListResult, BiliLoginStatus } from './bilibili'

export type BilibiliBridge = {
  status: () => Promise<BiliLoginStatus>
  login: () => Promise<BiliLoginStatus>
  logout: () => Promise<void>
  list: () => Promise<BiliListResult>
}
```
并在聚合 window API 的类型（与 `providers: ProvidersBridge` 等并列处）加：`bilibili: BilibiliBridge`。

- [ ] **Step 2: 在 `src/preload/index.ts` 定义并暴露桥**

```ts
import type { BilibiliBridge } from '../shared/types/ui'
import type { BiliListResult, BiliLoginStatus } from '../shared/types/bilibili'

const bilibili: BilibiliBridge = {
  status: () => ipcRenderer.invoke('bilibili:status') as Promise<BiliLoginStatus>,
  login: () => ipcRenderer.invoke('bilibili:login') as Promise<BiliLoginStatus>,
  logout: () => ipcRenderer.invoke('bilibili:logout') as Promise<void>,
  list: () => ipcRenderer.invoke('bilibili:list') as Promise<BiliListResult>,
}
```
把 `bilibili` 加入最终 `exposeInMainWorld('api', { ... })` 的对象（与 `providers`/`webSearch` 并列）。

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: 通过（无类型错误）

- [ ] **Step 4: commit**

```bash
git add src/preload/index.ts src/shared/types/ui.ts
git commit -m "feat(bilibili): preload bridge and UI types"
```

---

### Task 7: 渲染层列表视图 + 路由

**Files:**
- Create: `src/renderer/src/components/views/bilibili-view.tsx`
- Create: `src/renderer/src/routes/bilibili.tsx`
- Test: `src/renderer/src/components/views/bilibili-view.test.tsx`

**Interfaces:**
- Consumes: `window.api.bilibili.*`（Task 6）；类型 `BiliListResult`/`BiliLoginStatus`/`BiliVideo`
- Produces: 一个展示登录态、登录按钮、收藏夹分组与稍后再看的 React 视图。点击视频卡片暂时仅 `console.debug`（处理逻辑在里程碑 C 接入）。

> 实现前打开 `src/renderer/src/components/views/trending-view.tsx` 与 `src/renderer/src/routes/trending.tsx`，照搬其状态管理、加载/错误展示、样式类名与路由注册方式。下面给出结构骨架与一个可独立运行的测试。

- [ ] **Step 1: 写失败测试**

```tsx
// src/renderer/src/components/views/bilibili-view.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BilibiliView } from './bilibili-view'

const api = {
  status: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  list: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  // @ts-expect-error test shim for window.api
  globalThis.window.api = { bilibili: api }
})

describe('BilibiliView', () => {
  it('shows a login prompt when logged out', async () => {
    api.status.mockResolvedValue({ loggedIn: false, uname: null, mid: null })
    render(<BilibiliView />)
    await waitFor(() => expect(screen.getByRole('button', { name: /登录/ })).toBeInTheDocument())
  })

  it('renders folders and watch-later when logged in', async () => {
    api.status.mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
    api.list.mockResolvedValue({
      folders: [{ folder: { id: 1, title: 'CS', count: 1 }, videos: [
        { bvid: 'BV1', title: '视频甲', cover: '', author: 'up', durationSec: 1, intro: '', source: 'CS' },
      ] }],
      watchLater: [
        { bvid: 'BV2', title: '视频乙', cover: '', author: 'up', durationSec: 1, intro: '', source: '稍后再看' },
      ],
    })
    render(<BilibiliView />)
    await waitFor(() => expect(screen.getByText('视频甲')).toBeInTheDocument())
    expect(screen.getByText('视频乙')).toBeInTheDocument()
    expect(screen.getByText('CS')).toBeInTheDocument()
  })
})
```

> 若仓库的渲染测试约定与上面不同（例如 `@testing-library/react` 的引入方式、jsdom 环境配置），以 `trending-view.test.tsx` 为准对齐。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/renderer/src/components/views/bilibili-view.test.tsx`
Expected: FAIL（`Cannot find module './bilibili-view'`）

- [ ] **Step 3: 实现视图**

```tsx
// src/renderer/src/components/views/bilibili-view.tsx
//
// Shows the user's Bilibili favorites folders and watch-later list. Prompts for
// login when logged out. Clicking a video is a no-op until milestone C wires the
// summarize pipeline.
import { useCallback, useEffect, useState } from 'react'
import type { BiliListResult, BiliLoginStatus, BiliVideo } from '@shared/types/bilibili'

function VideoCard({ video, onClick }: { video: BiliVideo; onClick: (v: BiliVideo) => void }): JSX.Element {
  return (
    <button type="button" className="bili-card" onClick={() => onClick(video)}>
      {video.cover ? <img src={video.cover} alt="" className="bili-cover" /> : null}
      <div className="bili-title">{video.title}</div>
      <div className="bili-author">{video.author}</div>
    </button>
  )
}

export function BilibiliView(): JSX.Element {
  const [status, setStatus] = useState<BiliLoginStatus | null>(null)
  const [data, setData] = useState<BiliListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (st: BiliLoginStatus) => {
    if (!st.loggedIn) return
    setLoading(true)
    setError(null)
    try {
      setData(await window.api.bilibili.list())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    window.api.bilibili.status().then((st) => {
      setStatus(st)
      void refresh(st)
    })
  }, [refresh])

  const onLogin = useCallback(async () => {
    const st = await window.api.bilibili.login()
    setStatus(st)
    void refresh(st)
  }, [refresh])

  const onClickVideo = useCallback((v: BiliVideo) => {
    // Milestone C wires the summarize -> Obsidian pipeline here.
    console.debug('bilibili video clicked', v.bvid)
  }, [])

  if (status && !status.loggedIn) {
    return (
      <div className="bili-view">
        <p>未登录 Bilibili</p>
        <button type="button" onClick={onLogin}>登录 Bilibili</button>
      </div>
    )
  }

  return (
    <div className="bili-view">
      <div className="bili-header">
        <span>{status?.uname ?? ''}</span>
        {loading ? <span>加载中…</span> : null}
        {error ? <span className="bili-error">{error}</span> : null}
      </div>
      {data?.folders.map(({ folder, videos }) => (
        <section key={folder.id}>
          <h3>{folder.title}</h3>
          <div className="bili-grid">
            {videos.map((v) => (
              <VideoCard key={v.bvid} video={v} onClick={onClickVideo} />
            ))}
          </div>
        </section>
      ))}
      {data && data.watchLater.length > 0 ? (
        <section>
          <h3>稍后再看</h3>
          <div className="bili-grid">
            {data.watchLater.map((v) => (
              <VideoCard key={v.bvid} video={v} onClick={onClickVideo} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/renderer/src/components/views/bilibili-view.test.tsx`
Expected: PASS（2 passed）

- [ ] **Step 5: 注册路由**

打开 `src/renderer/src/routes/trending.tsx` 看其路由定义/注册方式，照搬创建 `src/renderer/src/routes/bilibili.tsx`，渲染 `<BilibiliView />`，并在应用的路由表/侧边导航处（与 trending 注册同位置）加入 Bilibili 入口。

- [ ] **Step 6: typecheck + 视图测试**

Run: `npm run typecheck && npm test -- src/renderer/src/components/views/bilibili-view.test.tsx`
Expected: typecheck 通过；测试 PASS

- [ ] **Step 7: commit**

```bash
git add src/renderer/src/components/views/bilibili-view.tsx src/renderer/src/components/views/bilibili-view.test.tsx src/renderer/src/routes/bilibili.tsx
git commit -m "feat(bilibili): favorites/watch-later list view and route"
```

---

### Task 8: 手动冒烟验证（里程碑 A 验收）

无新代码；这是里程碑 A 的验收门。

- [ ] **Step 1: 启动应用**

用项目的 run-desktop / `pnpm dev` 启动（参考 `run-desktop` skill）。

- [ ] **Step 2: 登录**

进入 Bilibili 视图 → 点"登录 Bilibili" → 扫码/登录 → 窗口自动关闭，顶部显示用户名。

- [ ] **Step 3: 看列表**

确认收藏夹分组与"稍后再看"出现，卡片有标题/作者/封面。

- [ ] **Step 4: 看日志**

`swarm-dev.log` 中能看到 `bilibili login captured`、`bilibili list ok`（含 folders/watchLater 计数、durationMs）。

- [ ] **Step 5: 持久化**

重启应用，仍是登录态（`bilibili:status` 走 nav 校验通过），列表能直接加载。

验收通过即里程碑 A 完成；里程碑 B（内容提取/转写）另起计划。

---

## Self-Review

- **Spec coverage（针对里程碑 A 范围）**：登录鉴权 ✔（Task 4/5/6/7）、收藏夹展示 ✔（Task 3/5/7）、稍后再看展示 ✔（Task 3/5/7）、凭证加密持久化 ✔（Task 2）、日志可定位 ✔（Task 4/5 各阶段 info/warn/error）。内容提取、转写、AI 总结、Obsidian 写入、队列均属里程碑 B/C，本计划有意不覆盖。
- **Placeholder scan**：无 TBD/TODO；每个代码步骤含完整代码；点击视频的占位行为已显式说明（里程碑 C 接入），非遗漏。
- **Type consistency**：`BiliCredentials`/`BiliVideo`/`BiliFavFolder`/`BiliLoginStatus`/`BiliListResult` 跨任务一致；`getFavResources(c, mediaId, folderTitle)` 三参签名在 Task 3 定义、Task 5 测试与调用一致；`buildList(c, mid, deps)` 在 Task 5 定义与测试一致；preload `bilibili.*` 四方法与 IPC 通道、UI 类型三处一致。
