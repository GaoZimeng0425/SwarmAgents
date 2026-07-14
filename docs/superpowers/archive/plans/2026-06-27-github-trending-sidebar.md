# GitHub 趋势侧栏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在左侧栏新增 "GitHub 趋势" 入口，展示 OSSInsight 公开 API 的热门仓库排行榜，点击仓库可一键发起 Agent 调研会话。

**Architecture:** 数据走主进程 + IPC（与 `web-search` 子系统同构）：渲染层用 react-query 调 `window.swarm.trending.get(period, language)` → `ipcMain 'trending:get'` → `trending-service.fetchTrending` → `https://api.ossinsight.io/v1/trends/repos/`，主进程做 1 小时内存缓存。渲染层是一个独立路由 `/trending` 的全屏视图，外加侧栏底部一个图标入口。

**Tech Stack:** Electron（main/preload/renderer 三进程）、TypeScript、React、TanStack Router（文件式路由）、TanStack Query、pino 日志、Vitest + Testing Library。

## Global Constraints

- 对话回复用中文；**代码注释与 commit message 一律英文**（见 CLAUDE.md §0）。
- 每条业务路径加结构化日志（pino，`createLogger({ process }).child({ component })`）：入口/出口 `info`、`catch` `error`、分支异常 `warn`、逐项细节 `debug`（CLAUDE.md §5）。
- 结构化日志第一个参数为对象：`log.info({ msg: '...', ... })`，不要字符串插值。
- 测试用 `npm test`（`cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`），**不要** `npx vitest` / `pnpm rebuild better-sqlite3`。
- 单文件单测：`npm test -- <文件相对路径>`。
- 渲染层组件/hook 测试文件首行加 `// @vitest-environment jsdom`。
- 共享别名：`@shared/*` → `src/shared/*`，`@/*` → `src/renderer/src/*`。
- Biome 格式化用 `npx biome check --write <file>`（scoped；`pnpm check` 会重排整个仓库，见项目记忆）。
- 最小改动、不顺手重构无关代码（CLAUDE.md §2/§3）。

---

### Task 1: 共享类型 + 主进程趋势服务

**Files:**
- Create: `src/shared/types/trending.ts`
- Create: `src/main/trending/service.ts`
- Test: `src/main/trending/service.test.ts`

**Interfaces:**
- Produces:
  - `TRENDING_PERIODS: readonly ['past_24_hours','past_week','past_month','past_3_months']`
  - `type TrendingPeriod = (typeof TRENDING_PERIODS)[number]`
  - `TRENDING_PERIOD_LABELS: Record<TrendingPeriod, string>`
  - `TRENDING_LANGUAGES: readonly string[]`（首项 `'All'`）
  - `type TrendingLanguage = (typeof TRENDING_LANGUAGES)[number]`
  - `type TrendingRepo = { repoName: string; description: string; language: string; stars: number; forks: number; pullRequests: number; totalScore: number; contributorLogins: string }`
  - `fetchTrending(period: TrendingPeriod, language: string): Promise<TrendingRepo[]>`

- [ ] **Step 1: 写共享类型文件**

Create `src/shared/types/trending.ts`:

```ts
// Shared types for the GitHub trending feature. Mirrors the params and result
// shape of OSSInsight's `trending-repos` public query.

export const TRENDING_PERIODS = ['past_24_hours', 'past_week', 'past_month', 'past_3_months'] as const
export type TrendingPeriod = (typeof TRENDING_PERIODS)[number]

// Chinese UI labels for each period (user-facing copy, not a code comment).
export const TRENDING_PERIOD_LABELS: Record<TrendingPeriod, string> = {
  past_24_hours: '过去 24 小时',
  past_week: '过去一周',
  past_month: '过去一月',
  past_3_months: '过去三月',
}

// Language filter options, taken verbatim from OSSInsight's trending-repos query.
// 'All' means no language filter.
export const TRENDING_LANGUAGES = [
  'All', 'JavaScript', 'Java', 'Python', 'PHP', 'C++', 'C#', 'TypeScript', 'Shell', 'C',
  'Ruby', 'Rust', 'Go', 'Kotlin', 'HCL', 'PowerShell', 'CMake', 'Groovy', 'PLpgSQL', 'TSQL',
  'Dart', 'Swift', 'HTML', 'CSS', 'Elixir', 'Haskell', 'Solidity', 'Assembly', 'R', 'Scala',
  'Julia', 'Lua', 'Clojure', 'Erlang', 'Common Lisp', 'Emacs Lisp', 'OCaml', 'MATLAB',
  'Objective-C', 'Perl', 'Fortran', 'Zig',
] as const
export type TrendingLanguage = (typeof TRENDING_LANGUAGES)[number]

export type TrendingRepo = {
  repoName: string
  description: string
  language: string
  stars: number
  forks: number
  pullRequests: number
  totalScore: number
  contributorLogins: string
}
```

- [ ] **Step 2: 写失败的服务测试**

Create `src/main/trending/service.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchTrending } from './service'

const apiBody = {
  type: 'sql_endpoint',
  data: {
    columns: [],
    rows: [
      {
        repo_id: '1',
        repo_name: 'owner/repo',
        description: 'a cool repo',
        language: 'Rust',
        stars: '123',
        forks: '45',
        pull_requests: '6',
        pushes: '7',
        total_score: '99.5',
        contributor_logins: 'alice,bob',
        collection_names: '',
      },
    ],
    result: {},
  },
}

function mockFetchOnce(body: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      json: async () => body,
    }))
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('fetchTrending', () => {
  it('maps snake_case rows to camelCase TrendingRepo with numeric fields', async () => {
    mockFetchOnce(apiBody)
    const repos = await fetchTrending('past_week', 'Rust')
    expect(repos).toHaveLength(1)
    expect(repos[0]).toEqual({
      repoName: 'owner/repo',
      description: 'a cool repo',
      language: 'Rust',
      stars: 123,
      forks: 45,
      pullRequests: 6,
      totalScore: 99.5,
      contributorLogins: 'alice,bob',
    })
  })

  it('caches by (period, language) within the TTL — second call does not re-fetch', async () => {
    mockFetchOnce(apiBody)
    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    await fetchTrending('past_month', 'Go')
    await fetchTrending('past_month', 'Go')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('re-fetches after the cache TTL expires', async () => {
    vi.useFakeTimers()
    mockFetchOnce(apiBody)
    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    await fetchTrending('past_3_months', 'Python')
    vi.advanceTimersByTime(61 * 60 * 1000) // > 1h
    await fetchTrending('past_3_months', 'Python')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('throws on a non-2xx response', async () => {
    mockFetchOnce({}, false, 500)
    await expect(fetchTrending('past_24_hours', 'Java')).rejects.toThrow(/500/)
  })
})
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `npm test -- src/main/trending/service.test.ts`
Expected: FAIL（`Cannot find module './service'`）

- [ ] **Step 4: 实现服务**

Create `src/main/trending/service.ts`:

```ts
// src/main/trending/service.ts
//
// Fetches GitHub trending repos from OSSInsight's public REST API and caches
// results in memory per (period, language). OSSInsight refreshes the data daily,
// so a 1h client cache is plenty and keeps the API friendly.
import { createLogger } from '@shared/logger'
import type { TrendingPeriod, TrendingRepo } from '@shared/types/trending'

const log = createLogger({ process: 'main' }).child({ component: 'trending' })

const API_BASE = 'https://api.ossinsight.io/v1/trends/repos/'
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

type CacheEntry = { at: number; repos: TrendingRepo[] }
const cache = new Map<string, CacheEntry>()

type ApiRow = Record<string, string | null>
type ApiResponse = { data?: { rows?: ApiRow[] } }

function toRepo(row: ApiRow): TrendingRepo {
  return {
    repoName: row.repo_name ?? '',
    description: row.description ?? '',
    language: row.language ?? '',
    stars: Number(row.stars ?? 0),
    forks: Number(row.forks ?? 0),
    pullRequests: Number(row.pull_requests ?? 0),
    totalScore: Number(row.total_score ?? 0),
    contributorLogins: row.contributor_logins ?? '',
  }
}

export async function fetchTrending(period: TrendingPeriod, language: string): Promise<TrendingRepo[]> {
  const key = `${period}|${language}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    log.debug({ msg: 'trending cache hit', period, language })
    return cached.repos
  }

  const url = `${API_BASE}?period=${encodeURIComponent(period)}&language=${encodeURIComponent(language)}`
  const startedAt = Date.now()
  log.info({ msg: 'trending fetch started', period, language })
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`OSSInsight API ${res.status} ${res.statusText}`)
    const body = (await res.json()) as ApiResponse
    const rows = body.data?.rows ?? []
    if (rows.length === 0) log.warn({ msg: 'trending returned no rows', period, language })
    const repos = rows.map(toRepo)
    cache.set(key, { at: Date.now(), repos })
    log.info({ msg: 'trending fetch ok', period, language, count: repos.length, durationMs: Date.now() - startedAt })
    return repos
  } catch (err) {
    log.error({
      msg: 'trending fetch failed',
      err: err instanceof Error ? err.message : String(err),
      period,
      language,
    })
    throw err
  }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npm test -- src/main/trending/service.test.ts`
Expected: PASS（4 个用例全过）

- [ ] **Step 6: 格式化并提交**

```bash
npx biome check --write src/shared/types/trending.ts src/main/trending/service.ts src/main/trending/service.test.ts
git add src/shared/types/trending.ts src/main/trending/service.ts src/main/trending/service.test.ts
git commit -m "feat(trending): shared types and OSSInsight fetch service with cache"
```

---

### Task 2: IPC 接线 + preload 桥 + 渲染层 API

**Files:**
- Create: `src/main/trending/ipc.ts`
- Create: `src/main/trending/index.ts`
- Modify: `src/main/index.ts`（boot wiring + before-quit dispose）
- Modify: `src/preload/index.ts`（新增 `trending` namespace 并加入 `swarm` 字面量）
- Modify: `src/shared/types/ui.ts`（`SwarmBridge` 增加 `trending` 成员）
- Modify: `src/renderer/src/lib/api.ts`（新增 `getTrendingRepos`）

**Interfaces:**
- Consumes: `fetchTrending`, `TRENDING_PERIODS`, `TrendingPeriod`, `TrendingRepo`（Task 1）
- Produces:
  - IPC 通道 `'trending:get'`，参数 `(period: unknown, language: unknown)`，返回 `Promise<TrendingRepo[]>`
  - `window.swarm.trending.get(period: TrendingPeriod, language: string): Promise<TrendingRepo[]>`
  - `swarmApi.getTrendingRepos(period: TrendingPeriod, language: string): Promise<TrendingRepo[]>`

> 本任务多为进程间接线，验证靠类型检查 + 构建（无独立单测，沿用 `web-search` 子系统无 ipc 单测的惯例）。

- [ ] **Step 1: 写 IPC 接线**

Create `src/main/trending/ipc.ts`:

```ts
// src/main/trending/ipc.ts
//
// Wires the trending subsystem to Electron IPC. Single read endpoint that
// validates params (falling back to safe defaults) and returns trending repos.
import { createLogger } from '@shared/logger'
import { TRENDING_PERIODS, type TrendingPeriod } from '@shared/types/trending'
import { ipcMain } from 'electron'

import { fetchTrending } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'trending-ipc' })

function asPeriod(v: unknown): TrendingPeriod {
  return TRENDING_PERIODS.includes(v as TrendingPeriod) ? (v as TrendingPeriod) : 'past_24_hours'
}

export function wireTrendingIpc(): { dispose: () => void } {
  ipcMain.handle('trending:get', (_e: Electron.IpcMainInvokeEvent, period: unknown, language: unknown) => {
    const p = asPeriod(period)
    const lang = typeof language === 'string' && language.length > 0 ? language : 'All'
    if (p !== period || lang !== language) {
      log.warn({ msg: 'trending params coerced to defaults', period, language, resolvedPeriod: p, resolvedLanguage: lang })
    }
    return fetchTrending(p, lang)
  })

  log.info({ msg: 'trending IPC wired' })

  return {
    dispose(): void {
      ipcMain.removeHandler('trending:get')
    },
  }
}
```

- [ ] **Step 2: 写子系统入口**

Create `src/main/trending/index.ts`:

```ts
// src/main/trending/index.ts
//
// Entry point for the trending subsystem. No persistent store — just wires IPC.
import { wireTrendingIpc } from './ipc'

export type TrendingHandle = {
  dispose(): void
}

export function initTrending(): TrendingHandle {
  const { dispose } = wireTrendingIpc()
  return { dispose }
}
```

- [ ] **Step 3: 在 main 启动流程接线**

Modify `src/main/index.ts`. Add the import near the other subsystem imports (around line 17, next to `import { initWebSearch } from './web-search'`):

```ts
import { initTrending } from './trending'
```

After the `budgets` init block (around line 60-61, after `log.info({ msg: 'budget config initialised' })`), add:

```ts
  const trending = initTrending()
  log.info({ msg: 'trending IPC initialised' })
```

In the existing `app.on('before-quit', () => { ... })` block (around line 63-68), add `trending.dispose()` after `budgets.dispose()`:

```ts
  app.on('before-quit', () => {
    providers.dispose()
    mcpServers.dispose()
    webSearch.dispose()
    budgets.dispose()
    trending.dispose()
  })
```

- [ ] **Step 4: preload 暴露 trending 桥**

Modify `src/preload/index.ts`. Inside the `swarm` object literal (around line 197, right after the `usage: { ... }` block and before `cron: { ... }`), add:

```ts
  trending: {
    get: (period: import('../shared/types/trending').TrendingPeriod, language: string) =>
      ipcRenderer.invoke('trending:get', period, language) as Promise<
        import('../shared/types/trending').TrendingRepo[]
      >,
  },
```

- [ ] **Step 5: SwarmBridge 类型增加 trending**

Modify `src/shared/types/ui.ts`. In `export type SwarmBridge = { ... }` (starts line 294), add right after the `usage: { ... }` block:

```ts
  trending: {
    get(
      period: import('./trending').TrendingPeriod,
      language: string
    ): Promise<import('./trending').TrendingRepo[]>
  }
```

- [ ] **Step 6: 渲染层 API 增加 getTrendingRepos**

Modify `src/renderer/src/lib/api.ts`. Add the import at the top (after line 14's `UsageStats` import):

```ts
import type { TrendingPeriod, TrendingRepo } from '@shared/types/trending'
```

Inside the `swarmApi` object, after `getUsageStats`, add:

```ts
  getTrendingRepos: (period: TrendingPeriod, language: string): Promise<TrendingRepo[]> =>
    window.swarm.trending.get(period, language),
```

- [ ] **Step 7: 类型检查 + 构建验证**

Run: `npm run typecheck`
Expected: 通过，无 `trending` 相关类型错误。

（若项目无 `typecheck` 脚本，运行 `npx tsc -p tsconfig.node.json --noEmit && npx tsc -p tsconfig.web.json --noEmit`，以 `package.json` 的实际脚本为准；先 `grep -n '"typecheck"\|"build"\|tsc' package.json` 确认。）

- [ ] **Step 8: 格式化并提交**

```bash
npx biome check --write src/main/trending/ipc.ts src/main/trending/index.ts src/main/index.ts src/preload/index.ts src/shared/types/ui.ts src/renderer/src/lib/api.ts
git add src/main/trending/ipc.ts src/main/trending/index.ts src/main/index.ts src/preload/index.ts src/shared/types/ui.ts src/renderer/src/lib/api.ts
git commit -m "feat(trending): wire IPC, preload bridge and renderer api"
```

---

### Task 3: useResearchRepo hook（点击仓库 → 新建调研会话）

**Files:**
- Create: `src/renderer/src/hooks/use-research-repo.ts`
- Test: `src/renderer/src/hooks/use-research-repo.test.tsx`

**Interfaces:**
- Consumes: `TrendingRepo`, `TrendingPeriod`, `TRENDING_PERIOD_LABELS`（Task 1）；`swarmApi.createSession`/`submitGoal`（既有）；`useSessionsStore`（既有，`select(id)`）；TanStack Router `useNavigate`。
- Produces:
  - `buildResearchPrompt(repo: TrendingRepo, period: TrendingPeriod): string`（导出，便于单测）
  - `useResearchRepo(): (repo: TrendingRepo, period: TrendingPeriod) => Promise<void>`（始终新建会话）

- [ ] **Step 1: 写失败的 prompt 测试**

Create `src/renderer/src/hooks/use-research-repo.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { TrendingRepo } from '@shared/types/trending'
import { describe, expect, it } from 'vitest'

import { buildResearchPrompt } from './use-research-repo'

const repo: TrendingRepo = {
  repoName: 'oven-sh/bun',
  description: 'Incredibly fast JavaScript runtime',
  language: 'Zig',
  stars: 1234,
  forks: 56,
  pullRequests: 7,
  totalScore: 88,
  contributorLogins: 'a,b',
}

describe('buildResearchPrompt', () => {
  it('includes the owner/repo, GitHub URL and metrics for the period', () => {
    const prompt = buildResearchPrompt(repo, 'past_week')
    expect(prompt).toContain('oven-sh/bun')
    expect(prompt).toContain('https://github.com/oven-sh/bun')
    expect(prompt).toContain('过去一周')
    expect(prompt).toContain('1234')
    expect(prompt).toContain('56')
    expect(prompt).toContain('7')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -- src/renderer/src/hooks/use-research-repo.test.tsx`
Expected: FAIL（`buildResearchPrompt` 未定义）

- [ ] **Step 3: 实现 hook**

Create `src/renderer/src/hooks/use-research-repo.ts`:

```ts
import type { TrendingPeriod, TrendingRepo } from '@shared/types/trending'
import { TRENDING_PERIOD_LABELS } from '@shared/types/trending'
import { useNavigate } from '@tanstack/react-router'

import { swarmApi } from '@/lib/api'
import { useSessionsStore } from '@/stores/sessions'

// Build the Chinese research goal handed to the agent when a trending repo is clicked.
export function buildResearchPrompt(repo: TrendingRepo, period: TrendingPeriod): string {
  const label = TRENDING_PERIOD_LABELS[period]
  return [
    `调研 GitHub 仓库 ${repo.repoName}（https://github.com/${repo.repoName}）：`,
    `它解决什么问题、核心技术栈、近期活跃度（${label}内新增 ${repo.stars}⭐ / ${repo.forks} forks / ${repo.pullRequests} PR），`,
    `以及值得关注的点。`,
  ].join('')
}

// Returns a callback that always creates a FRESH session, submits a research
// goal about the repo, and navigates to the new session.
export function useResearchRepo(): (repo: TrendingRepo, period: TrendingPeriod) => Promise<void> {
  const navigate = useNavigate()
  return async (repo, period) => {
    const { sessionId } = await swarmApi.createSession()
    useSessionsStore.getState().select(sessionId)
    await swarmApi.submitGoal(sessionId, buildResearchPrompt(repo, period), undefined, {
      permissionMode: 'ask',
      executionMode: 'goal',
      agentType: 'ceo',
    })
    void navigate({ to: '/session/$sessionId', params: { sessionId } })
  }
}
```

> 注意：`agentType: 'ceo'` 与 `HomeComposer` 的默认值一致；`permissionMode`/`executionMode` 同其默认。若 `TaskOptions` 字段名与此处不符，以 `@shared/types/task` 的 `TaskOptions` 为准（先 `grep -n "type TaskOptions" -A8 src/shared/types/task.ts` 核对）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test -- src/renderer/src/hooks/use-research-repo.test.tsx`
Expected: PASS

- [ ] **Step 5: 格式化并提交**

```bash
npx biome check --write src/renderer/src/hooks/use-research-repo.ts src/renderer/src/hooks/use-research-repo.test.tsx
git add src/renderer/src/hooks/use-research-repo.ts src/renderer/src/hooks/use-research-repo.test.tsx
git commit -m "feat(trending): useResearchRepo hook to launch repo research session"
```

---

### Task 4: TrendingView 视图 + 路由

**Files:**
- Create: `src/renderer/src/components/views/trending-view.tsx`
- Create: `src/renderer/src/routes/trending.tsx`
- Test: `src/renderer/src/components/views/trending-view.test.tsx`

**Interfaces:**
- Consumes: `swarmApi.getTrendingRepos`（Task 2）；`useResearchRepo`（Task 3）；`TRENDING_PERIODS`/`TRENDING_PERIOD_LABELS`/`TRENDING_LANGUAGES`/`TrendingPeriod`（Task 1）；`NativeSelect`/`NativeSelectOption`（`@/components/ui/native-select`）。
- Produces: `TrendingView` 组件；路由 `/trending`。

- [ ] **Step 1: 写失败的视图测试**

Create `src/renderer/src/components/views/trending-view.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type { TrendingRepo } from '@shared/types/trending'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { swarmApi } from '@/lib/api'
import { TrendingView } from './trending-view'

vi.mock('@/hooks/use-research-repo', () => ({
  useResearchRepo: () => vi.fn(),
}))

const repo: TrendingRepo = {
  repoName: 'oven-sh/bun',
  description: 'Incredibly fast JavaScript runtime',
  language: 'Zig',
  stars: 1234,
  forks: 56,
  pullRequests: 7,
  totalScore: 88,
  contributorLogins: 'a,b',
}

function wrap(node: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TrendingView', () => {
  it('renders the trending repo rows on success', async () => {
    vi.spyOn(swarmApi, 'getTrendingRepos').mockResolvedValue([repo])
    render(wrap(<TrendingView />))
    expect(await screen.findByText('oven-sh/bun')).toBeInTheDocument()
    expect(screen.getByText('Incredibly fast JavaScript runtime')).toBeInTheDocument()
  })

  it('shows an error state with a retry control when the fetch fails', async () => {
    vi.spyOn(swarmApi, 'getTrendingRepos').mockRejectedValue(new Error('boom'))
    render(wrap(<TrendingView />))
    expect(await screen.findByRole('button', { name: /重试/ })).toBeInTheDocument()
  })

  it('shows an empty state when no repos are returned', async () => {
    vi.spyOn(swarmApi, 'getTrendingRepos').mockResolvedValue([])
    render(wrap(<TrendingView />))
    await waitFor(() => expect(screen.getByText(/暂无/)).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -- src/renderer/src/components/views/trending-view.test.tsx`
Expected: FAIL（`./trending-view` 不存在）

- [ ] **Step 3: 实现 TrendingView**

Create `src/renderer/src/components/views/trending-view.tsx`:

```tsx
import {
  TRENDING_LANGUAGES,
  TRENDING_PERIOD_LABELS,
  TRENDING_PERIODS,
  type TrendingPeriod,
  type TrendingRepo,
} from '@shared/types/trending'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, GitFork, GitPullRequest, Star } from 'lucide-react'
import { useState } from 'react'

import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Button } from '@/components/ui/button'
import { useResearchRepo } from '@/hooks/use-research-repo'
import { swarmApi } from '@/lib/api'

export function TrendingView(): React.JSX.Element {
  const [period, setPeriod] = useState<TrendingPeriod>('past_24_hours')
  const [language, setLanguage] = useState<string>('All')
  const research = useResearchRepo()

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['trending', period, language],
    queryFn: () => swarmApi.getTrendingRepos(period, language),
  })

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <h1 className="mr-auto font-semibold text-foreground/90 text-lg">GitHub 趋势</h1>
        <NativeSelect onChange={(e) => setPeriod(e.target.value as TrendingPeriod)} value={period}>
          {TRENDING_PERIODS.map((p) => (
            <NativeSelectOption key={p} value={p}>
              {TRENDING_PERIOD_LABELS[p]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect onChange={(e) => setLanguage(e.target.value)} value={language}>
          {TRENDING_LANGUAGES.map((l) => (
            <NativeSelectOption key={l} value={l}>
              {l}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      {isError ? (
        <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
          <p>加载趋势失败</p>
          <Button onClick={() => void refetch()} variant="outline">
            重试
          </Button>
        </div>
      ) : isPending ? (
        <div className="py-12 text-center text-muted-foreground">加载中…</div>
      ) : data.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">暂无趋势数据</div>
      ) : (
        <ol className="flex flex-col gap-2">
          {data.map((repo, i) => (
            <RepoRow key={repo.repoName} index={i} onResearch={() => void research(repo, period)} repo={repo} />
          ))}
        </ol>
      )}
    </div>
  )
}

function RepoRow(props: { repo: TrendingRepo; index: number; onResearch: () => void }): React.JSX.Element {
  const { repo, index, onResearch } = props
  return (
    <li className="flex items-start gap-3 rounded-md border border-sidebar-border p-3 transition-colors hover:bg-sidebar-accent">
      <span className="w-6 shrink-0 text-center font-mono text-muted-foreground text-sm">{index + 1}</span>
      <button className="min-w-0 flex-1 text-left" onClick={onResearch} type="button">
        <div className="truncate font-medium text-foreground">{repo.repoName}</div>
        {repo.description ? (
          <div className="truncate text-muted-foreground text-sm">{repo.description}</div>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-3 text-muted-foreground text-xs">
          {repo.language ? <span>{repo.language}</span> : null}
          <span className="inline-flex items-center gap-1">
            <Star className="size-3" /> {repo.stars}
          </span>
          <span className="inline-flex items-center gap-1">
            <GitFork className="size-3" /> {repo.forks}
          </span>
          <span className="inline-flex items-center gap-1">
            <GitPullRequest className="size-3" /> {repo.pullRequests}
          </span>
        </div>
      </button>
      <a
        aria-label="在浏览器打开"
        className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
        href={`https://github.com/${repo.repoName}`}
        rel="noreferrer"
        target="_blank"
      >
        <ExternalLink className="size-4" />
      </a>
    </li>
  )
}
```

> 若 `NativeSelect` 的 props 与示例不符，以 `agent-form-sheet.tsx`（`src/renderer/src/components/views/agent-form-sheet.tsx:125`）的真实用法为准。`Button` 的 `variant` 取值以 `@/components/ui/button` 实际支持为准。

- [ ] **Step 4: 实现路由**

Create `src/renderer/src/routes/trending.tsx`:

```tsx
import { createFileRoute } from '@tanstack/react-router'

import { TrendingView } from '@/components/views/trending-view'

export const Route = createFileRoute('/trending')({ component: TrendingView })
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npm test -- src/renderer/src/components/views/trending-view.test.tsx`
Expected: PASS（3 个用例全过）

> 路由树若由 TanStack Router 插件自动生成（`routeTree.gen.ts`），首次 `npm run dev`/`build` 会写入 `/trending`；无需手改生成文件。如类型报 `'/trending'` 未知，运行一次 dev/build 让插件重生成。

- [ ] **Step 6: 格式化并提交**

```bash
npx biome check --write src/renderer/src/components/views/trending-view.tsx src/renderer/src/routes/trending.tsx src/renderer/src/components/views/trending-view.test.tsx
git add src/renderer/src/components/views/trending-view.tsx src/renderer/src/routes/trending.tsx src/renderer/src/components/views/trending-view.test.tsx
git commit -m "feat(trending): TrendingView with period/language filters and route"
```

---

### Task 5: 侧栏入口图标

**Files:**
- Modify: `src/renderer/src/components/app-sidebar.tsx`

**Interfaces:**
- Consumes: 既有 `iconBtn` 样式、`Tooltip`/`Link` 模式；新路由 `/trending`（Task 4）。

- [ ] **Step 1: 加 TrendingUp 图标 import**

Modify `src/renderer/src/components/app-sidebar.tsx`. Update the lucide import (line 2) to include `TrendingUp`:

```ts
import { BarChart3, CalendarClock, Settings, TrendingUp } from 'lucide-react'
```

- [ ] **Step 2: 在底部图标区加 GitHub 趋势链接**

Insert a new `Tooltip` block right after the `用量统计` tooltip block (after the `BarChart3` link's closing `</Tooltip>`, around line 61), before the `设置` block:

```tsx
          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                  activeProps={{ 'data-active': 'true' } as any}
                  className={iconBtn}
                  // biome-ignore lint/suspicious/noExplicitAny: `to` widened over Router's typed registry
                  to={'/trending' as any}
                >
                  <TrendingUp />
                </Link>
              }
            />
            <TooltipContent side="top">GitHub 趋势</TooltipContent>
          </Tooltip>
```

- [ ] **Step 3: 跑全量测试，确认无回归**

Run: `npm test`
Expected: PASS（含 Task 1/3/4 新增用例，无既有用例回归）。

- [ ] **Step 4: 启动 app 手动验证**

用 run-desktop skill（或 `npm run dev`）启动应用，验证：
- 侧栏底部出现「GitHub 趋势」图标，hover 显示 tooltip。
- 点击进入 `/trending`，默认 `过去 24 小时` / `All` 显示榜单。
- 切换周期/语言列表刷新。
- 点击某仓库 → 新建会话并自动发起调研 goal，跳转到该会话。
- 点击右侧外链图标 → 系统浏览器打开该 GitHub 仓库。

- [ ] **Step 5: 格式化并提交**

```bash
npx biome check --write src/renderer/src/components/app-sidebar.tsx
git add src/renderer/src/components/app-sidebar.tsx
git commit -m "feat(trending): add GitHub trending entry to sidebar"
```

---

## 实现顺序与依赖

```
Task 1 (类型+服务)  →  Task 2 (IPC/preload/api)  →  Task 3 (hook)  →  Task 4 (视图+路由)  →  Task 5 (侧栏入口)
```

Task 3 与 Task 4 都依赖 Task 1 的类型；Task 4 依赖 Task 2 的 `getTrendingRepos` 与 Task 3 的 `useResearchRepo`；Task 5 依赖 Task 4 的路由。按序执行。

## Self-Review 记录

- **Spec 覆盖**：数据源/缓存 → Task 1；主进程服务+IPC+preload → Task 1/2；渲染 API → Task 2；视图+周期/语言筛选+三态 → Task 4；侧栏入口 → Task 5；点击发起调研会话 → Task 3（被 Task 4 消费）；外链 → Task 4 RepoRow。无遗漏。
- **占位符**：无 TBD/TODO；每个代码步骤含完整代码。
- **类型一致性**：`TrendingRepo`/`TrendingPeriod`/`fetchTrending`/`getTrendingRepos`/`useResearchRepo`/`buildResearchPrompt` 在各任务间签名一致；preload 与 `SwarmBridge` 的 `trending.get` 签名一致。
- **风险点**（实现时按真实代码核对，已在对应步骤标注）：`TaskOptions` 字段名、`NativeSelect`/`Button` 的 props、`typecheck` 脚本名、TanStack Router 路由树生成。
