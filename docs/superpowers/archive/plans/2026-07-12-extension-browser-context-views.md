# Extension Browser-Context Views (Bookmarks + Tabs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read-only bookmarks and open-tabs views to the SwarmAgents Chrome extension side panel, each with a raw-JSON debug surface, available without a WS connection.

**Architecture:** The side panel gains a tab switcher (文章 / 书签 / 标签页). The existing article logic is extracted into `ArticlesTab` (zero behavior change). `BookmarksTab` calls `chrome.bookmarks.getTree()` directly and renders a tree. `TabsTab` pulls a snapshot from the background SW's tabs-store and subscribes to live `tabs.on*` deltas relayed as `runtime.sendMessage`. A shared `RawJson` component shows the unmodified API payload per view.

**Tech Stack:** TypeScript, React 19, WXT (Chrome MV3), Vitest, `chrome.bookmarks` / `chrome.tabs` APIs, Tailwind v4, `@swarm/ui` Button.

**Spec:** `docs/superpowers/specs/2026-07-12-extension-browser-context-views-design.md`

## Global Constraints

- All code and comments in English; conversational replies in Chinese (per `AGENTS.md` §0).
- Extension tests run via `pnpm --filter @swarm/extension run test` (plain vitest — no Electron, no native modules). The extension has no `@` alias; tests import via relative paths and use the `.wxt/tsconfig.json` globals (`browser`, `chrome` are typed by `@types/chrome`).
- Pre-commit hook runs `biome check --write --staged` + `pnpm run typecheck`; a failing typecheck aborts the commit. Do not bypass with `--no-verify`.
- This touches only `apps/extension` — no desktop, protocol, or shared changes. Do not edit any file outside `apps/extension/`.
- `@swarm/protocol` and `@swarm/ui` resolve via source-path aliases in `wxt.config.ts` and `tsconfig.json` — import them directly, they are bundled from source.
- Follow existing style: `lib/*.ts` for pure logic + `lib/*.test.ts` for unit tests; `entrypoints/` for WXT entrypoints. Match the fake-object test pattern in `lib/transport-ws.test.ts`.
- WXT auto-generates `manifest.json` from `entrypoints/` + the `manifest` block in `wxt.config.ts`. Content scripts, the background SW, and the side panel are all entrypoints.

---

## File Structure

```
apps/extension/
├── entrypoints/
│   ├── background.ts              ← Modify: add tabs-store init + tabs/bookmarks message routing
│   └── sidepanel/
│       ├── SidePanel.tsx          ← Modify: shell becomes tab switcher; article logic moves out
│       ├── ArticlesTab.tsx        ← Create: existing article logic extracted verbatim
│       ├── BookmarksTab.tsx       ← Create: bookmarks tree view + RawJson
│       ├── TabsTab.tsx            ← Create: tabs list + real-time updates + RawJson
│       └── RawJson.tsx            ← Create: shared collapsible raw-JSON region
├── lib/
│   ├── bookmarks.ts               ← Create: getTree() → BookmarkNode[] projection
│   ├── bookmarks.test.ts          ← Create: unit tests for the projection
│   ├── tabs-store.ts              ← Create: background tabs state machine
│   ├── tabs-store.test.ts         ← Create: unit tests for the state machine
│   ├── tabs-shared.ts             ← Create: shared TabInfo / WindowTabs / message types
│   ├── extract.ts                 ← Existing, untouched
│   └── transport-ws.ts            ← Existing, untouched
└── wxt.config.ts                  ← Modify: permissions += 'bookmarks', 'tabs'
```

**Responsibilities:**
- `lib/tabs-shared.ts` — the types (`TabInfo`, `WindowTabs`) and message-type constants shared between background and panel. Pure types, no runtime logic, so both sides import without circular deps.
- `lib/tabs-store.ts` — the state machine: `loadAll()`, `on*` event handlers, `snapshot()`, lifecycle. Imported only by `background.ts`.
- `lib/bookmarks.ts` — `getBookmarks()` (async, wraps `chrome.bookmarks.getTree()`) + `toBookmarkNodes()` (pure projection). Imported only by `BookmarksTab.tsx`.
- `entrypoints/sidepanel/RawJson.tsx` — presentational, no state beyond `<details>` open/close.

---

### Task 1: Extract `ArticlesTab` from `SidePanel` (zero behavior change)

**Files:**
- Create: `apps/extension/entrypoints/sidepanel/ArticlesTab.tsx`
- Modify: `apps/extension/entrypoints/sidepanel/SidePanel.tsx`

**Interfaces:**
- Consumes: the existing `browser.runtime.sendMessage` API (unchanged).
- Produces: `ArticlesTab` component with props `{ connected: boolean }`, rendered by the `SidePanel` shell. Later tasks add sibling tabs alongside it.

**Why first:** Isolates the existing article logic so the shell refactor in Task 2 is a pure structural change. If article behavior breaks, it breaks in this task alone — easy to bisect.

- [ ] **Step 1: Create `ArticlesTab.tsx` with the article logic moved verbatim**

Create `apps/extension/entrypoints/sidepanel/ArticlesTab.tsx`. Move the article-related state (`collecting`, `collectStatus`, `articles`, `listError`, `selectedId`, `analysis`, `analyzedAt`), the `wsHost`/`token`/`savedHint` config state, all article-related effects, and the `collect`/`saveConfig`/`refreshList`/`hostnameOf`/`shortDate` helpers out of `SidePanel.tsx`. The component takes `connected` as a prop:

```tsx
import { type JSX, useCallback, useEffect, useState } from 'react'
import type { ArticleSummary, CollectedArticleWithAnalysis } from '@swarm/protocol'
import { Button } from '@swarm/ui'

type HealthResult = { ok: true; count: number } | { ok: false; error: string }
type CollectStatus = { kind: 'pending' } | { kind: 'ok'; articleId?: string } | { kind: 'err'; error: string }
type ListResult = { ok: true; articles: CollectedArticleWithAnalysis[] } | { ok: false; error: string }
type AnalysisResult =
  | { ok: true; summary: ArticleSummary | null; analyzedAt: string | null }
  | { ok: false; error: string }

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function shortDate(iso: string): string {
  try {
    const d = new Date(iso)
    return `${d.getMonth() + 1}月${d.getDate()}日`
  } catch {
    return ''
  }
}

export function ArticlesTab({ connected }: { connected: boolean }): JSX.Element {
  const [collecting, setCollecting] = useState(false)
  const [collectStatus, setCollectStatus] = useState<CollectStatus | null>(null)

  const [wsHost, setWsHost] = useState('ws://127.0.0.1:47777')
  const [token, setToken] = useState('')
  const [savedHint, setSavedHint] = useState(false)

  const [articles, setArticles] = useState<CollectedArticleWithAnalysis[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<ArticleSummary | null>(null)
  const [, setAnalyzedAt] = useState<string | null>(null)

  useEffect(() => {
    browser.storage.local.get(['wsHost', 'token']).then((v) => {
      if (v.wsHost) setWsHost(v.wsHost as string)
      if (v.token) setToken(v.token as string)
    })
  }, [])

  const refreshList = useCallback((): void => {
    browser.runtime.sendMessage({ type: 'listArticles' }, (r: ListResult) => {
      if (r?.ok) {
        setArticles(r.articles)
        setListError(null)
      } else {
        setListError(r?.error ?? '加载失败')
      }
    })
  }, [])

  useEffect(() => {
    if (connected) refreshList()
  }, [connected, refreshList])

  useEffect(() => {
    const listener = (msg: { type?: string; articleId?: string; summary?: ArticleSummary }): void => {
      if (msg?.type === 'article.analysisComplete' && msg.articleId === selectedId && msg.summary) {
        setAnalysis(msg.summary)
        setAnalyzedAt(new Date().toISOString())
      }
    }
    browser.runtime.onMessage.addListener(listener)
    return () => browser.runtime.onMessage.removeListener(listener)
  }, [selectedId])

  useEffect(() => {
    if (!selectedId) {
      setAnalysis(null)
      setAnalyzedAt(null)
      return
    }
    browser.runtime.sendMessage({ type: 'getArticleAnalysis', articleId: selectedId }, (r: AnalysisResult) => {
      if (r?.ok) {
        setAnalysis(r.summary)
        setAnalyzedAt(r.analyzedAt)
      }
    })
  }, [selectedId])

  const collect = (): void => {
    setCollecting(true)
    setCollectStatus({ kind: 'pending' })
    browser.runtime.sendMessage(
      { type: 'collectCurrentPage' },
      (r: { ok: boolean; articleId?: string; error?: string }) => {
        if (r?.ok) {
          setCollectStatus({ kind: 'ok', articleId: r.articleId })
          refreshList()
        } else {
          setCollectStatus({ kind: 'err', error: r?.error ?? 'unknown error' })
        }
        setCollecting(false)
      }
    )
  }

  const saveConfig = (): void => {
    browser.storage.local.set({ wsHost, token }).then(() => {
      setSavedHint(true)
      setTimeout(() => setSavedHint(false), 2500)
    })
  }

  const selected = articles.find((a) => a.id === selectedId) ?? null

  return (
    <>
      {!connected ? (
        <section className="flex flex-col gap-2 rounded-md border border-border p-3">
          <label className="text-muted-foreground text-xs" htmlFor="token">
            Token(从桌面端 设置 → 远程连接 复制)
          </label>
          <input
            className="rounded border border-border bg-background px-2 py-1 font-mono text-xs"
            id="token"
            onChange={(e) => setToken(e.target.value)}
            placeholder="粘贴 token"
            type="password"
            value={token}
          />
          <details className="text-muted-foreground text-xs">
            <summary className="cursor-pointer select-none">高级(WS host)</summary>
            <input
              className="mt-2 w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
              onChange={(e) => setWsHost(e.target.value)}
              value={wsHost}
            />
          </details>
          <Button className="mt-1" disabled={token.trim().length === 0} onClick={saveConfig} size="sm">
            保存并重连
          </Button>
          {savedHint && <p className="text-emerald-600 text-xs">已保存,后台正在重连…</p>}
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <Button className="w-full" disabled={collecting} onClick={collect}>
              📄 收集当前页到文章库
            </Button>
            {collectStatus?.kind === 'pending' && <p className="text-muted-foreground text-xs">◷ 发送中…</p>}
            {collectStatus?.kind === 'ok' && <p className="text-emerald-600 text-xs">✓ 已收集</p>}
            {collectStatus?.kind === 'err' && <p className="text-destructive text-xs">✗ {collectStatus.error}</p>}
          </section>

          {selected ? (
            <section className="flex min-h-0 flex-1 flex-col gap-3">
              <button
                className="text-left text-muted-foreground text-xs underline"
                onClick={() => setSelectedId(null)}
                type="button"
              >
                ← 返回列表
              </button>
              <div className="flex flex-col gap-0.5">
                <h4 className="font-medium text-sm leading-snug">{selected.title}</h4>
                <p className="text-muted-foreground text-xs">
                  {selected.siteName ?? hostnameOf(selected.url)} · {shortDate(selected.collectedAt)}
                </p>
              </div>
              <div className="border-border border-t" />
              {analysis ? (
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                  <div className="rounded-md border border-border bg-muted/30 p-2.5">
                    <p className="mb-1 text-[10px] text-muted-foreground tracking-wide">一句话结论</p>
                    <p className="text-foreground text-xs leading-5">{analysis.gist}</p>
                  </div>
                  {analysis.points.length > 0 ? (
                    <div>
                      <p className="mb-1 text-[10px] text-muted-foreground tracking-wide">核心要点</p>
                      <ul className="flex list-disc flex-col gap-1 pl-4 text-xs leading-5">
                        {analysis.points.map((p, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: plain string list, no stable id
                          <li key={i}>{p}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {analysis.takeaways.length > 0 ? (
                    <div>
                      <p className="mb-1 text-[10px] text-muted-foreground tracking-wide">可带走洞察</p>
                      <ul className="flex list-disc flex-col gap-1 pl-4 text-xs leading-5">
                        {analysis.takeaways.map((p, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: plain string list, no stable id
                          <li key={i}>{p}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">这篇文章还没有分析。去 desktop 选中它点「AI 分析」。</p>
              )}
              <a
                className="text-muted-foreground text-xs underline"
                href={selected.url}
                rel="noreferrer"
                target="_blank"
              >
                打开原文 ↗
              </a>
            </section>
          ) : (
            <section className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground text-xs">
                  已收集 <span className="tabular-nums">{articles.length}</span> 篇
                </p>
                <button className="text-muted-foreground text-xs underline" onClick={refreshList} type="button">
                  刷新
                </button>
              </div>
              {listError ? <p className="text-destructive text-xs">{listError}</p> : null}
              <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                {articles.length === 0 && !listError ? (
                  <p className="text-muted-foreground text-xs">还没有收集的文章。打开一篇文章,点上方按钮收集。</p>
                ) : null}
                {articles.map((a) => (
                  <button
                    className="flex flex-col gap-0.5 rounded border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-sidebar-accent"
                    key={a.id}
                    onClick={() => setSelectedId(a.id)}
                    type="button"
                  >
                    <div className="flex items-center gap-1.5">
                      {a.summary ? (
                        <span className="rounded bg-primary px-1 font-medium text-[9px] text-primary-foreground">
                          AI
                        </span>
                      ) : null}
                      <span className="line-clamp-1 font-medium text-xs">{a.title}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {a.siteName ?? hostnameOf(a.url)} · {shortDate(a.collectedAt)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </>
  )
}
```

This is the existing `SidePanel.tsx` body verbatim, minus the `connected` state (now a prop) and minus the health-probe effect (stays in the shell). The `HealthResult` type alias moves here because the article tab no longer owns it; the shell keeps its own health logic.

- [ ] **Step 2: Rewrite `SidePanel.tsx` as a thin shell that renders `ArticlesTab`**

Replace the entire content of `apps/extension/entrypoints/sidepanel/SidePanel.tsx` with:

```tsx
// The extension's side panel shell. Owns only the health probe (connection
// state) and the tab switcher. Each tab (articles / bookmarks / tabs) is a
// self-contained component. The tab switcher is always visible — bookmarks and
// tabs work without a WS connection; only the articles tab needs one.
import { type JSX, useEffect, useState } from 'react'

import { ArticlesTab } from './ArticlesTab'

type Tab = 'articles' | 'bookmarks' | 'tabs'
type HealthResult = { ok: true; count: number } | { ok: false; error: string }

export function SidePanel(): JSX.Element {
  const [connected, setConnected] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('articles')

  useEffect(() => {
    let stopped = false
    const probe = (): void => {
      browser.runtime.sendMessage({ type: 'health' }, (r: HealthResult) => {
        if (stopped) return
        if (r?.ok) setConnected(true)
        else {
          setConnected(false)
          setTimeout(probe, 3000)
        }
      })
    }
    probe()
    return () => {
      stopped = true
    }
  }, [])

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <header className="flex flex-col gap-1">
        <h3 className="font-semibold text-foreground">SwarmAgents</h3>
        <p className="text-muted-foreground text-xs">连接桌面端,收集并查看文章分析。</p>
      </header>

      <nav className="flex gap-1 border-border border-b pb-2">
        {(['articles', 'bookmarks', 'tabs'] as const).map((t) => (
          <button
            className={`rounded px-2 py-1 text-xs transition-colors ${
              activeTab === t ? 'bg-sidebar-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
            key={t}
            onClick={() => setActiveTab(t)}
            type="button"
          >
            {t === 'articles' ? '文章' : t === 'bookmarks' ? '书签' : '标签页'}
          </button>
        ))}
      </nav>

      {activeTab === 'articles' && <ArticlesTab connected={connected} />}
      {activeTab === 'bookmarks' && <p className="text-muted-foreground text-xs">(书签视图即将上线)</p>}
      {activeTab === 'tabs' && <p className="text-muted-foreground text-xs">(标签页视图即将上线)</p>}
    </div>
  )
}
```

The bookmarks/tabs tabs are placeholders for now — Tasks 3 and 4 fill them in. The tab switcher is always rendered (not gated on `connected`).

- [ ] **Step 3: Run typecheck + build to verify the refactor compiles**

Run: `pnpm --filter @swarm/extension run typecheck`
Expected: PASS (no type errors).

Run: `pnpm --filter @swarm/extension run build`
Expected: PASS — `.output/chrome-mv3/` is produced.

- [ ] **Step 4: Manual smoke test — article behavior unchanged**

Load the rebuilt extension in Chrome/Dia (`apps/extension/.output/chrome-mv3`). Open the side panel. Verify:
- The tab switcher (文章 / 书签 / 标签页) appears below the header.
- "文章" is active by default; the token form / article list behaves exactly as before.
- Clicking "书签" or "标签页" shows the placeholder text.
- Switching back to "文章" restores the article view.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/entrypoints/sidepanel/ArticlesTab.tsx apps/extension/entrypoints/sidepanel/SidePanel.tsx
git commit -m "refactor(extension): extract ArticlesTab, add side-panel tab switcher shell"
```

---

### Task 2: Create `RawJson` shared component

**Files:**
- Create: `apps/extension/entrypoints/sidepanel/RawJson.tsx`

**Interfaces:**
- Consumes: nothing (pure presentational).
- Produces: `RawJson({ data: unknown; label: string })` — used by `BookmarksTab` (Task 3) and `TabsTab` (Task 4).

**Why separate:** Two tasks depend on it; landing it first lets both consume a stable interface. It is trivial but establishes the raw-payload contract (§7.3 of the spec): the component receives the **unmodified** API return, never a projection.

- [ ] **Step 1: Create `RawJson.tsx`**

```tsx
// Shared collapsible raw-JSON debug region. Used at the bottom of the
// bookmarks and tabs views to show the UNMODIFIED chrome.* API return value
// (not a projection). Native <details> gives expand/collapse semantics for
// free; <pre> preserves JSON indentation. Payloads are small (bookmarks tree,
// tabs snapshot) so eager serialization is fine.
import { type JSX } from 'react'

export function RawJson({ data, label }: { data: unknown; label: string }): JSX.Element {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer select-none text-muted-foreground text-xs">{label}</summary>
      <pre className="mt-1 overflow-x-auto rounded bg-muted/30 p-2 text-[10px] leading-tight">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  )
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter @swarm/extension run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/extension/entrypoints/sidepanel/RawJson.tsx
git commit -m "feat(extension): add RawJson shared debug component"
```

---

### Task 3: Bookmarks view (`lib/bookmarks.ts` + `BookmarksTab`)

**Files:**
- Create: `apps/extension/lib/bookmarks.ts`
- Create: `apps/extension/lib/bookmarks.test.ts`
- Create: `apps/extension/entrypoints/sidepanel/BookmarksTab.tsx`
- Modify: `apps/extension/entrypoints/sidepanel/SidePanel.tsx` (wire `BookmarksTab` into the switcher)
- Modify: `apps/extension/wxt.config.ts` (add `bookmarks` permission)

**Interfaces:**
- Consumes: `chrome.bookmarks` API; `RawJson` from Task 2.
- Produces: `BookmarksTab()` component rendered by SidePanel. `getBookmarks(): Promise<{ tree: BookmarkNode[]; raw: chrome.bookmarks.BookmarkTreeNode[] }>` — the panel uses `tree` for rendering and `raw` for the `RawJson` region.

- [ ] **Step 1: Write the failing test for `toBookmarkNodes`**

Create `apps/extension/lib/bookmarks.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import { toBookmarkNodes } from './bookmarks'

// Minimal fake matching the shape chrome.bookmarks.getTree() returns. We cast
// through unknown so the test doesn't depend on @types/chrome's full type.
type RawNode = {
  id: string
  title: string
  url?: string
  children?: RawNode[]
  dateAdded?: number
}

describe('toBookmarkNodes', () => {
  it('projects a root folder with nested bookmarks and subfolders', () => {
    const raw: RawNode[] = [
      {
        id: '1',
        title: '书签栏',
        children: [
          { id: '2', title: 'GitHub', url: 'https://github.com', dateAdded: 1700000000000 },
          {
            id: '3',
            title: '开发',
            children: [{ id: '4', title: 'MDN', url: 'https://developer.mozilla.org' }],
          },
        ],
      },
    ]
    const tree = toBookmarkNodes(raw as unknown as chrome.bookmarks.BookmarkTreeNode[])
    expect(tree).toHaveLength(1)
    expect(tree[0].title).toBe('书签栏')
    expect(tree[0].children).toHaveLength(2)
    expect(tree[0].children![0]).toMatchObject({ id: '2', title: 'GitHub', url: 'https://github.com' })
    expect(tree[0].children![1].children).toHaveLength(1)
    expect(tree[0].children![1].children![0].title).toBe('MDN')
  })

  it('preserves dateAdded and treats nodes without url as folders', () => {
    const raw: RawNode[] = [
      {
        id: '1',
        title: 'root',
        dateAdded: 1700000000000,
        children: [{ id: '2', title: 'folder-no-date' }],
      },
    ]
    const tree = toBookmarkNodes(raw as unknown as chrome.bookmarks.BookmarkTreeNode[])
    expect(tree[0].dateAdded).toBe(1700000000000)
    expect(tree[0].children![0].url).toBeUndefined()
    expect(tree[0].children![0].children).toBeUndefined()
  })

  it('handles an empty tree', () => {
    expect(toBookmarkNodes([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @swarm/extension run test -- bookmarks`
Expected: FAIL — `toBookmarkNodes` is not defined (module not found).

- [ ] **Step 3: Implement `lib/bookmarks.ts`**

```typescript
// Bookmarks data layer. getBookmarks() calls chrome.bookmarks.getTree() and
// returns both the projected tree (for rendering) and the raw API payload (for
// the RawJson debug region). toBookmarkNodes is the pure projection, tested in
// isolation.

export type BookmarkNode = {
  id: string
  title: string
  url?: string // absent => folder
  children?: BookmarkNode[]
  dateAdded?: number
}

// Project the raw chrome.bookmarks.BookmarkTreeNode[] into a leaner tree that
// preserves the hierarchy. Drops fields the view doesn't need (index,
// parentId, dateGroupModified, etc.) but keeps id/title/url/children/dateAdded.
export function toBookmarkNodes(raw: chrome.bookmarks.BookmarkTreeNode[]): BookmarkNode[] {
  return raw.map((node) => {
    const out: BookmarkNode = { id: node.id, title: node.title }
    if (node.url !== undefined) out.url = node.url
    if (node.dateAdded !== undefined) out.dateAdded = node.dateAdded
    if (node.children) out.children = toBookmarkNodes(node.children)
    return out
  })
}

export async function getBookmarks(): Promise<{
  tree: BookmarkNode[]
  raw: chrome.bookmarks.BookmarkTreeNode[]
}> {
  const raw = await chrome.bookmarks.getTree()
  return { tree: toBookmarkNodes(raw), raw }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @swarm/extension run test -- bookmarks`
Expected: PASS — 3 tests.

- [ ] **Step 5: Create `BookmarksTab.tsx`**

Create `apps/extension/entrypoints/sidepanel/BookmarksTab.tsx`:

```tsx
// Bookmarks view. Calls chrome.bookmarks.getTree() directly (no background
// relay — there is no real-time requirement). Renders a recursive tree with
// expand/collapse; first-level folders are expanded by default. The RawJson
// region at the bottom shows the unmodified API payload.
import { type JSX, useEffect, useState } from 'react'

import type { BookmarkNode } from '../../lib/bookmarks'
import { getBookmarks } from '../../lib/bookmarks'
import { RawJson } from './RawJson'

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function shortDate(ms: number): string {
  try {
    const d = new Date(ms)
    return `${d.getMonth() + 1}月${d.getDate()}日`
  } catch {
    return ''
  }
}

// Recursive tree node renderer. Folders toggle expand; leaves link out.
function BookmarkItem({ node, expanded, onToggle }: {
  node: BookmarkNode
  expanded: Set<string>
  onToggle: (id: string) => void
}): JSX.Element {
  const isFolder = node.children !== undefined
  const isOpen = expanded.has(node.id)
  return (
    <div className="flex flex-col">
      <button
        className="flex items-center gap-1 rounded px-1.5 py-1 text-left text-xs hover:bg-sidebar-accent"
        onClick={() => isFolder && onToggle(node.id)}
        type="button"
      >
        {isFolder ? (
          <span className="text-muted-foreground text-[10px] w-3">{isOpen ? '▼' : '▶'}</span>
        ) : (
          <span className="text-muted-foreground text-[10px] w-3">•</span>
        )}
        <span className={isFolder ? 'font-medium' : ''}>{node.title || '(未命名)'}</span>
        {!isFolder && node.url ? (
          <span className="text-muted-foreground text-[10px] truncate">{hostnameOf(node.url)}</span>
        ) : null}
        {!isFolder && node.dateAdded ? (
          <span className="text-muted-foreground text-[10px] ml-auto">{shortDate(node.dateAdded)}</span>
        ) : null}
      </button>
      {isFolder && isOpen ? (
        <div className="ml-3 border-border border-l pl-1">
          {node.children!.map((child) => (
            <BookmarkItem expanded={expanded} key={child.id} node={child} onToggle={onToggle} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function BookmarksTab(): JSX.Element {
  const [tree, setTree] = useState<BookmarkNode[]>([])
  const [raw, setRaw] = useState<chrome.bookmarks.BookmarkTreeNode[]>([])
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = (): void => {
    setError(null)
    getBookmarks()
      .then(({ tree, raw }) => {
        setTree(tree)
        setRaw(raw)
        // Expand top-level folders by default on first load.
        setExpanded(new Set(tree.filter((n) => n.children !== undefined).map((n) => n.id)))
      })
      .catch((err) => setError(String(err)))
  }

  useEffect(() => {
    load()
  }, [])

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const count = tree.reduce((acc, n) => acc + (n.children?.length ?? 0), 0)

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          <span className="tabular-nums">{count}</span> 个书签
        </p>
        <button className="text-muted-foreground text-xs underline" onClick={load} type="button">
          刷新
        </button>
      </div>
      {error ? <p className="text-destructive text-xs">加载失败:{error}</p> : null}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {tree.length === 0 && !error ? <p className="text-muted-foreground text-xs">没有书签。</p> : null}
        {tree.map((node) => (
          <BookmarkItem expanded={expanded} key={node.id} node={node} onToggle={toggle} />
        ))}
      </div>
      <RawJson data={raw} label="原始书签 JSON" />
    </section>
  )
}
```

- [ ] **Step 6: Wire `BookmarksTab` into the SidePanel switcher**

In `apps/extension/entrypoints/sidepanel/SidePanel.tsx`:

Add the import at the top (after the `ArticlesTab` import):

```tsx
import { BookmarksTab } from './BookmarksTab'
```

Replace the bookmarks placeholder line:

```tsx
{activeTab === 'bookmarks' && <p className="text-muted-foreground text-xs">(书签视图即将上线)</p>}
```

with:

```tsx
{activeTab === 'bookmarks' && <BookmarksTab />}
```

- [ ] **Step 7: Add the `bookmarks` permission to the manifest**

In `apps/extension/wxt.config.ts`, change the `permissions` array:

From:
```typescript
    permissions: ['storage', 'alarms', 'scripting'],
```

To:
```typescript
    permissions: ['storage', 'alarms', 'scripting', 'bookmarks'],
```

- [ ] **Step 8: Run typecheck + build + tests**

Run: `pnpm --filter @swarm/extension run typecheck`
Expected: PASS.

Run: `pnpm --filter @swarm/extension run test`
Expected: PASS — bookmarks tests (3) + existing extract/transport-ws tests.

Run: `pnpm --filter @swarm/extension run build`
Expected: PASS.

- [ ] **Step 9: Manual smoke test**

Load the rebuilt extension. Open side panel → click "书签". Verify:
- The bookmarks tree renders with "书签栏" expanded by default.
- Clicking a folder toggles expand/collapse.
- Each bookmark shows title, hostname, date.
- The "原始书签 JSON" region expands to show the raw `getTree()` payload.
- "刷新" reloads the tree.

- [ ] **Step 10: Commit**

```bash
git add apps/extension/lib/bookmarks.ts apps/extension/lib/bookmarks.test.ts \
        apps/extension/entrypoints/sidepanel/BookmarksTab.tsx \
        apps/extension/entrypoints/sidepanel/SidePanel.tsx \
        apps/extension/wxt.config.ts
git commit -m "feat(extension): add bookmarks tree view with raw-JSON debug"
```

---

### Task 4: Tabs shared types + state machine (`lib/tabs-shared.ts`, `lib/tabs-store.ts`)

**Files:**
- Create: `apps/extension/lib/tabs-shared.ts`
- Create: `apps/extension/lib/tabs-store.ts`
- Create: `apps/extension/lib/tabs-store.test.ts`

**Interfaces:**
- Consumes: `chrome.tabs` API (in the store, via the background).
- Produces: `TabInfo`, `WindowTabs` types; `TABS_MSG` message-type constants; `createTabsStore()` factory returning `{ loadAll(), applyCreated(), applyUpdated(), applyRemoved(), applyActivated(), snapshot() }`. Task 5 wires this into `background.ts`; Task 6's `TabsTab` consumes the message types.

**Why before the background wiring:** The store is pure logic with a fake-`chrome` test — it can be fully TDD'd before touching `background.ts`. This isolates the state-machine correctness from MV3 message plumbing.

- [ ] **Step 1: Create `lib/tabs-shared.ts` (shared types + message constants)**

```typescript
// Types and message-type constants shared between the background SW (which owns
// tabs state) and the side-panel TabsTab (which renders it). Pure declarations
// — no runtime logic, so both sides import without circular deps.

// A slim projection of chrome.tabs.Tab — only what the view/debug needs.
export type TabInfo = {
  id: number
  windowId: number
  title: string
  url: string
  favIconUrl?: string
  active: boolean // whether this tab is the active tab of its window
}

// Tabs grouped by window, the shape the UI renders.
export type WindowTabs = {
  windowId: number
  incognito: boolean // retained; always false in v1 (no incognito access)
  tabs: TabInfo[]
}

// runtime.sendMessage message types (the `type` field routes them).
export const TABS_MSG = {
  getSnapshot: 'tabs:getSnapshot',
  snapshot: 'tabs:snapshot',
  changed: 'tabs:changed',
  snapshotError: 'tabs:snapshotError',
} as const

export type TabsChangedKind = 'created' | 'updated' | 'removed' | 'activated'

// The delta pushed to the panel on each tabs.on* event.
export type TabsChangedMessage = {
  type: typeof TABS_MSG.changed
  kind: TabsChangedKind
  tab: TabInfo
}
```

- [ ] **Step 2: Write the failing test for the tabs store**

Create `apps/extension/lib/tabs-store.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import { createTabsStore } from './tabs-store'

// Fake chrome.tabs for unit testing. The store calls chrome.tabs.query and
// registers on* listeners; we capture both. We type this as `unknown` then
// cast at the call site so the test does not pull in the full @types/chrome
// surface beyond what the store uses.
type Tab = {
  id: number
  windowId: number
  title: string
  url: string
  favIconUrl?: string
  active?: boolean
  incognito?: boolean
}

function fakeChrome(initialTabs: Tab[]) {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
  const chrome = {
    tabs: {
      query: async () => initialTabs.map((t) => ({ ...t })),
      onCreated: { addListener: (fn: (...a: unknown[]) => void) => (handlers.onCreated ??= []).push(fn) },
      onUpdated: { addListener: (fn: (...a: unknown[]) => void) => (handlers.onUpdated ??= []).push(fn) },
      onRemoved: { addListener: (fn: (...a: unknown[]) => void) => (handlers.onRemoved ??= []).push(fn) },
      onAttached: { addListener: (fn: (...a: unknown[]) => void) => (handlers.onAttached ??= []).push(fn) },
      onActivated: { addListener: (fn: (...a: unknown[]) => void) => (handlers.onActivated ??= []).push(fn) },
    },
  }
  return { chrome, handlers }
}

describe('createTabsStore', () => {
  it('loadAll produces a snapshot grouped by window with active flags', async () => {
    const { chrome } = fakeChrome([
      { id: 1, windowId: 10, title: 'A', url: 'https://a.com', active: true },
      { id: 2, windowId: 10, title: 'B', url: 'https://b.com', active: false },
      { id: 3, windowId: 20, title: 'C', url: 'https://c.com', active: true },
    ])
    const store = createTabsStore(chrome as unknown as typeof chrome)
    await store.loadAll()
    const snap = store.snapshot()
    expect(snap).toHaveLength(2)
    const w10 = snap.find((w) => w.windowId === 10)!
    expect(w10.tabs).toHaveLength(2)
    expect(w10.tabs[0].active).toBe(true)
    expect(w10.tabs[1].active).toBe(false)
  })

  it('applyCreated adds a tab into its window group', async () => {
    const { chrome, handlers } = fakeChrome([])
    const store = createTabsStore(chrome as unknown as typeof chrome)
    await store.loadAll()
    expect(store.snapshot()).toHaveLength(0)

    // Simulate tabs.onCreated firing.
    handlers.onCreated[0]({ id: 5, windowId: 10, title: 'New', url: 'https://n.com', active: false })
    const snap = store.snapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0].windowId).toBe(10)
    expect(snap[0].tabs[0].id).toBe(5)
  })

  it('applyUpdated merges changeInfo into an existing tab', async () => {
    const { chrome, handlers } = fakeChrome([
      { id: 1, windowId: 10, title: 'Old', url: 'https://old.com', active: true },
    ])
    const store = createTabsStore(chrome as unknown as typeof chrome)
    await store.loadAll()

    handlers.onUpdated[0](
      1,
      { title: 'New' },
      { id: 1, windowId: 10, title: 'New', url: 'https://old.com', active: true }
    )
    const tab = store.snapshot()[0].tabs[0]
    expect(tab.title).toBe('New')
    expect(tab.url).toBe('https://old.com')
  })

  it('applyRemoved deletes a tab and drops the window if empty', async () => {
    const { chrome, handlers } = fakeChrome([
      { id: 1, windowId: 10, title: 'Only', url: 'https://o.com', active: true },
    ])
    const store = createTabsStore(chrome as unknown as typeof chrome)
    await store.loadAll()

    handlers.onRemoved[0](1, { windowId: 10, isWindowClosing: false })
    expect(store.snapshot()).toHaveLength(0)
  })

  it('applyActivated flips active flags within a window', async () => {
    const { chrome, handlers } = fakeChrome([
      { id: 1, windowId: 10, title: 'A', url: 'https://a.com', active: true },
      { id: 2, windowId: 10, title: 'B', url: 'https://b.com', active: false },
    ])
    const store = createTabsStore(chrome as unknown as typeof chrome)
    await store.loadAll()

    handlers.onActivated[0]({ tabId: 2, windowId: 10 })
    const tabs = store.snapshot()[0].tabs
    expect(tabs.find((t) => t.id === 1)!.active).toBe(false)
    expect(tabs.find((t) => t.id === 2)!.active).toBe(true)
  })

  it('snapshot is empty before loadAll (lazy init)', () => {
    const { chrome } = fakeChrome([])
    const store = createTabsStore(chrome as unknown as typeof chrome)
    expect(store.snapshot()).toEqual([])
  })

  it('re-loadAll after a simulated SW restart yields a fresh snapshot', async () => {
    const { chrome } = fakeChrome([
      { id: 1, windowId: 10, title: 'A', url: 'https://a.com', active: true },
    ])
    const store = createTabsStore(chrome as unknown as typeof chrome)
    await store.loadAll()
    expect(store.snapshot()).toHaveLength(1)

    // Simulate SW restart: a new store instance (in-memory state gone).
    const store2 = createTabsStore(chrome as unknown as typeof chrome)
    expect(store2.snapshot()).toEqual([]) // lazy, not yet loaded
    await store2.loadAll()
    expect(store2.snapshot()).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @swarm/extension run test -- tabs-store`
Expected: FAIL — `createTabsStore` is not defined.

- [ ] **Step 4: Implement `lib/tabs-store.ts`**

The factory registers the `chrome.tabs.on*` listeners internally, so the tests' fake-chrome handlers (captured via `addListener`) route straight into the store's mutators.

```typescript
// Background-side tabs state machine. The SW owns a single store instance:
// loadAll() pulls a full snapshot on first consumer request (lazy); the
// chrome.tabs.on* listeners (registered inside the factory) apply incremental
// deltas. snapshot() returns the current state grouped by window. Task 5 wires
// this into background.ts and bridges deltas to the panel.
import type { TabInfo, WindowTabs } from './tabs-shared'

export type TabsStore = {
  loadAll(): Promise<void>
  snapshot(): WindowTabs[]
}

export function createTabsStore(chromeApi: {
  tabs: {
    query(opts: Record<string, unknown>): Promise<chrome.tabs.Tab[]>
    onCreated: { addListener(fn: (tab: chrome.tabs.Tab) => void): void }
    onUpdated: { addListener(fn: (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void): void }
    onRemoved: { addListener(fn: (id: number, info: chrome.tabs.TabRemoveInfo) => void): void }
    onAttached: { addListener(fn: (id: number, info: chrome.tabs.TabAttachInfo) => void): void }
    onActivated: { addListener(fn: (info: chrome.tabs.TabActiveInfo) => void): void }
  }
}): TabsStore {
  const tabs = new Map<number, TabInfo>()
  const windows = new Map<number, { incognito: boolean }>()
  let loaded = false

  function toRecord(tab: chrome.tabs.Tab): TabInfo {
    return {
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title ?? '',
      url: tab.url ?? '',
      favIconUrl: tab.favIconUrl,
      active: tab.active ?? false,
    }
  }

  function upsert(rec: TabInfo): void {
    tabs.set(rec.id, rec)
    if (!windows.has(rec.windowId)) windows.set(rec.windowId, { incognito: false })
  }

  // created
  chromeApi.tabs.onCreated.addListener((tab) => {
    upsert(toRecord(tab))
  })

  // updated — merge changeInfo (title/url/favIconUrl) into the existing record.
  chromeApi.tabs.onUpdated.addListener((_id, info, tab) => {
    const existing = tabs.get(tab.id)
    if (!existing) {
      upsert(toRecord(tab))
      return
    }
    existing.title = info.title ?? tab.title ?? existing.title
    existing.url = info.url ?? tab.url ?? existing.url
    if (info.favIconUrl !== undefined) existing.favIconUrl = info.favIconUrl
  })

  // removed
  chromeApi.tabs.onRemoved.addListener((id) => {
    tabs.delete(id)
  })

  // attached — tab moved to a different window
  chromeApi.tabs.onAttached.addListener((id, info) => {
    const rec = tabs.get(id)
    if (rec) {
      rec.windowId = info.newWindowId
      if (!windows.has(info.newWindowId)) windows.set(info.newWindowId, { incognito: false })
    }
  })

  // activated — flip active flags within the window
  chromeApi.tabs.onActivated.addListener((info) => {
    for (const rec of tabs.values()) {
      if (rec.windowId === info.windowId) rec.active = rec.id === info.tabId
    }
  })

  function rebuild(): void {
    const liveWindows = new Set<number>()
    for (const rec of tabs.values()) liveWindows.add(rec.windowId)
    for (const wid of windows.keys()) {
      if (!liveWindows.has(wid)) windows.delete(wid)
    }
  }

  return {
    async loadAll() {
      const all = await chromeApi.tabs.query({})
      tabs.clear()
      windows.clear()
      for (const tab of all) upsert(toRecord(tab))
      loaded = true
    },

    snapshot() {
      if (!loaded) return []
      rebuild()
      const byWindow = new Map<number, TabInfo[]>()
      for (const rec of tabs.values()) {
        const arr = byWindow.get(rec.windowId) ?? []
        arr.push(rec)
        byWindow.set(rec.windowId, arr)
      }
      const result: WindowTabs[] = []
      for (const [windowId, tabList] of byWindow) {
        const meta = windows.get(windowId) ?? { incognito: false }
        result.push({ windowId, incognito: meta.incognito, tabs: tabList })
      }
      return result
    },
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @swarm/extension run test -- tabs-store`
Expected: PASS — 7 tests.

If the `applyRemoved` test fails because the window isn't dropped, verify `rebuild()` runs in `snapshot()` and removes empty windows. (The `onRemoved` handler only deletes the tab from the Map; `snapshot()`'s `rebuild()` prunes the empty window.)

- [ ] **Step 6: Commit**

```bash
git add apps/extension/lib/tabs-shared.ts apps/extension/lib/tabs-store.ts apps/extension/lib/tabs-store.test.ts
git commit -m "feat(extension): add tabs state machine with lazy init and incremental updates"
```

---

### Task 5: Wire tabs-store into the background SW + message routing

**Files:**
- Modify: `apps/extension/entrypoints/background.ts`
- Modify: `apps/extension/wxt.config.ts` (add `tabs` permission)

**Interfaces:**
- Consumes: `createTabsStore` from Task 4; `TABS_MSG`, `WindowTabs`, `TabsChangedMessage` from `tabs-shared.ts`.
- Produces: background message handlers for `tabs:getSnapshot` (responds with `tabs:snapshot` or `tabs:snapshotError`) and forwards live `tabs.on*` deltas as `tabs:changed` messages while a panel is listening.

**Why before TabsTab:** The background must be ready to answer `tabs:getSnapshot` before the panel component can fetch. Landing the background wiring + manual curl-style verification (via the panel console) de-risks the panel work.

- [ ] **Step 1: Add the `tabs` permission**

In `apps/extension/wxt.config.ts`, change:

```typescript
    permissions: ['storage', 'alarms', 'scripting', 'bookmarks'],
```

to:

```typescript
    permissions: ['storage', 'alarms', 'scripting', 'bookmarks', 'tabs'],
```

- [ ] **Step 2: Wire the store + message routing into `background.ts`**

In `apps/extension/entrypoints/background.ts`:

Add imports at the top (after the existing imports):

```typescript
import { createTabsStore } from '../lib/tabs-store'
import { TABS_MSG, type WindowTabs, type TabInfo, type TabsChangedKind } from '../lib/tabs-shared'
```

Inside the `defineBackground(() => { ... })` body, after the existing `browser.alarms` / `browser.runtime.onInstalled` setup and **before** the existing `browser.runtime.onMessage.addListener`, add the store init and listening-flag:

```typescript
  // --- Tabs store (lazy-initialized on first tabs:getSnapshot request).
  // The store registers its own chrome.tabs.on* listeners inside the factory.
  let tabsStore: ReturnType<typeof createTabsStore> | null = null
  let tabsListening = false // true while a panel wants live deltas

  function getTabsStore() {
    if (!tabsStore) {
      tabsStore = createTabsStore(chrome.tabs)
      // While at least one panel is listening, forward each delta. The store's
      // on* handlers already mutated state by the time we'd want to read it,
      // so we re-listen here purely to broadcast. (Listener order: the store
      // registered its listeners in createTabsStore; these fire after.)
      const emit = (kind: TabsChangedKind, tab: chrome.tabs.Tab) => {
        if (!tabsListening) return
        const info: TabInfo = {
          id: tab.id,
          windowId: tab.windowId,
          title: tab.title ?? '',
          url: tab.url ?? '',
          favIconUrl: tab.favIconUrl,
          active: tab.active ?? false,
        }
        browser.runtime.sendMessage({ type: TABS_MSG.changed, kind, tab: info }).catch(() => {
          /* panel may be closed; ignore */
        })
      }
      chrome.tabs.onCreated.addListener((tab) => emit('created', tab))
      chrome.tabs.onUpdated.addListener((_id, _info, tab) => emit('updated', tab))
      chrome.tabs.onRemoved.addListener((id) => {
        if (!tabsListening) return
        // onRemoved gives no full Tab; emit a minimal tombstone.
        browser.runtime
          .sendMessage({ type: TABS_MSG.changed, kind: 'removed', tab: { id, windowId: -1, title: '', url: '', active: false } })
          .catch(() => {})
      })
      chrome.tabs.onActivated.addListener((info) => {
        if (!tabsListening) return
        chrome.tabs.get(info.tabId).then((tab) => emit('activated', tab)).catch(() => {})
      })
    }
    return tabsStore
  }
```

Then, inside the existing `browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => { ... })` body, add the `tabs:getSnapshot` handler **before** the `return false` at the end:

```typescript
    if ((msg as { type?: string })?.type === TABS_MSG.getSnapshot) {
      ;(async () => {
        try {
          const store = getTabsStore()
          await store.loadAll()
          tabsListening = true
          const windows: WindowTabs[] = store.snapshot()
          sendResponse({ type: TABS_MSG.snapshot, windows })
        } catch (err) {
          sendResponse({ type: TABS_MSG.snapshotError, error: String(err) })
        }
      })()
      return true
    }
```

**Note on `loadAll` idempotency:** `loadAll()` clears and re-queries every time it is called. This means every `tabs:getSnapshot` (including the manual "刷新" from the panel) does a fresh full query. This is intentional and cheap — it guarantees correctness over optimization, and the spec's manual-refresh philosophy permits it. The incremental `on*` listeners keep the store current between refreshes.

- [ ] **Step 3: Run typecheck + build**

Run: `pnpm --filter @swarm/extension run typecheck`
Expected: PASS.

Run: `pnpm --filter @swarm/extension run build`
Expected: PASS.

- [ ] **Step 4: Manual verification via the panel console**

Load the rebuilt extension. Open the side panel, open its DevTools (right-click → Inspect). In the console:

```javascript
browser.runtime.sendMessage({ type: 'tabs:getSnapshot' }, (r) => console.log(r))
```

Expected: logs `{ type: 'tabs:snapshot', windows: [...] }` with the current windows' tabs. Open or close a browser tab, then re-run the message — verify the snapshot reflects the change.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/entrypoints/background.ts apps/extension/wxt.config.ts
git commit -m "feat(extension): wire tabs-store into background with snapshot + live delta routing"
```

---

### Task 6: TabsTab view component + wire into SidePanel

**Files:**
- Create: `apps/extension/entrypoints/sidepanel/TabsTab.tsx`
- Modify: `apps/extension/entrypoints/sidepanel/SidePanel.tsx` (wire `TabsTab` into the switcher)

**Interfaces:**
- Consumes: `TABS_MSG`, `WindowTabs`, `TabInfo`, `TabsChangedMessage` from `tabs-shared.ts`; `RawJson` from Task 2; the background's `tabs:getSnapshot` / `tabs:snapshot` / `tabs:changed` / `tabs:snapshotError` messages from Task 5.
- Produces: `TabsTab()` component rendering the live tabs list grouped by window.

- [ ] **Step 1: Create `TabsTab.tsx`**

```tsx
// Tabs view. On mount, requests a snapshot from the background (which owns the
// tabs store) and subscribes to live `tabs:changed` deltas. The projected
// render updates live; the RawJson region shows the initial snapshot payload
// statically (labeled with a timestamp) per spec §14 — deltas do not refresh it.
//
// Listener hygiene: the onMessage listener is a named function reference so it
// can be removed cleanly on unmount (Acceptance §10.7). An inline arrow would
// leak.
import { type JSX, useEffect, useRef, useState } from 'react'

import { TABS_MSG, type TabInfo, type WindowTabs } from '../../lib/tabs-shared'
import { RawJson } from './RawJson'

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function TabsTab(): JSX.Element {
  const [windows, setWindows] = useState<WindowTabs[]>([])
  const [rawSnapshot, setRawSnapshot] = useState<unknown>(null)
  const [snapshotAt, setSnapshotAt] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  // Keep the latest windows in a ref so the onMessage delta handler (registered
  // once) can read/derive the next state without re-registering on every render.
  const windowsRef = useRef<WindowTabs[]>([])
  useEffect(() => {
    windowsRef.current = windows
  }, [windows])

  useEffect(() => {
    const refresh = (): void => {
      browser.runtime.sendMessage({ type: TABS_MSG.getSnapshot }, (r) => {
        if (r?.type === TABS_MSG.snapshot) {
          setWindows(r.windows)
          setRawSnapshot(r)
          setSnapshotAt(new Date().toLocaleTimeString())
          setError(null)
        } else if (r?.type === TABS_MSG.snapshotError) {
          setError(r.error ?? '快照获取失败')
        }
      })
    }

    // Named listener for clean removal. Applies a `tabs:changed` delta to the
    // local copy of the windows snapshot.
    const onMsg = (msg: { type?: string; kind?: string; tab?: TabInfo }): void => {
      if (msg?.type !== TABS_MSG.changed || !msg.tab) return
      const tab = msg.tab
      const kind = msg.kind as 'created' | 'updated' | 'removed' | 'activated'
      setWindows((prev) => {
        let next = prev.map((w) => ({ ...w, tabs: [...w.tabs] }))
        if (kind === 'removed') {
          next = next
            .map((w) => ({ ...w, tabs: w.tabs.filter((t) => t.id !== tab.id) }))
            .filter((w) => w.tabs.length > 0)
          return next
        }
        if (kind === 'activated') {
          next = next.map((w) => ({
            ...w,
            tabs: w.tabs.map((t) => ({ ...t, active: t.id === tab.id })),
          }))
          return next
        }
        // created or updated: upsert into the tab's window group.
        let found = false
        next = next.map((w) => {
          if (w.windowId !== tab.windowId) return w
          const idx = w.tabs.findIndex((t) => t.id === tab.id)
          if (idx >= 0) {
            w.tabs[idx] = tab
            found = true
          }
          return w
        })
        if (!found) {
          const existing = next.find((w) => w.windowId === tab.windowId)
          if (existing) {
            existing.tabs.push(tab)
          } else {
            next.push({ windowId: tab.windowId, incognito: false, tabs: [tab] })
          }
        }
        return next
      })
    }

    refresh()
    browser.runtime.onMessage.addListener(onMsg)
    return () => {
      browser.runtime.onMessage.removeListener(onMsg)
    }
  }, [])

  const refresh = (): void => {
    setError(null)
    browser.runtime.sendMessage({ type: TABS_MSG.getSnapshot }, (r) => {
      if (r?.type === TABS_MSG.snapshot) {
        setWindows(r.windows)
        setRawSnapshot(r)
        setSnapshotAt(new Date().toLocaleTimeString())
      } else if (r?.type === TABS_MSG.snapshotError) {
        setError(r.error ?? '快照获取失败')
      }
    })
  }

  const totalTabs = windows.reduce((acc, w) => acc + w.tabs.length, 0)

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          <span className="tabular-nums">{windows.length}</span> 窗口 ·{' '}
          <span className="tabular-nums">{totalTabs}</span> 标签页
        </p>
        <button className="text-muted-foreground text-xs underline" onClick={refresh} type="button">
          刷新
        </button>
      </div>
      {error ? <p className="text-destructive text-xs">快照获取失败:{error}</p> : null}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {windows.length === 0 && !error ? <p className="text-muted-foreground text-xs">没有打开的标签页。</p> : null}
        {windows.map((w) => (
          <details key={w.windowId} open>
            <summary className="cursor-pointer select-none text-muted-foreground text-xs">
              窗口 {w.windowId} · {w.incognito ? '隐身' : '普通'}
            </summary>
            <div className="ml-2 mt-1 flex flex-col gap-0.5 border-border border-l pl-2">
              {w.tabs.map((t) => (
                <div className="flex items-center gap-1.5 px-1 py-0.5 text-xs" key={t.id}>
                  {t.active ? <span className="text-primary text-[10px]">●</span> : <span className="text-muted-foreground text-[10px]">○</span>}
                  <span className={t.active ? 'font-medium' : ''}>{t.title || '(加载中)'}</span>
                  <span className="text-muted-foreground text-[10px] truncate">{hostnameOf(t.url)}</span>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
      <RawJson data={rawSnapshot} label={`原始标签页 JSON (快照于 ${snapshotAt})`} />
    </section>
  )
}
```

- [ ] **Step 2: Wire `TabsTab` into the SidePanel switcher**

In `apps/extension/entrypoints/sidepanel/SidePanel.tsx`:

Add the import (after `BookmarksTab` import):

```tsx
import { TabsTab } from './TabsTab'
```

Replace the tabs placeholder line:

```tsx
{activeTab === 'tabs' && <p className="text-muted-foreground text-xs">(标签页视图即将上线)</p>}
```

with:

```tsx
{activeTab === 'tabs' && <TabsTab />}
```

- [ ] **Step 3: Run typecheck + build + tests**

Run: `pnpm --filter @swarm/extension run typecheck`
Expected: PASS.

Run: `pnpm --filter @swarm/extension run test`
Expected: PASS — all unit tests.

Run: `pnpm --filter @swarm/extension run build`
Expected: PASS.

- [ ] **Step 4: Manual smoke test — real-time updates**

Load the rebuilt extension. Open side panel → click "标签页". Verify:
- The tabs list shows all non-incognito windows' tabs, grouped by window.
- The active tab in each window has a filled dot (●) and bold title.
- **Open a new tab in the browser** → it appears in the panel within ~1s.
- **Close a tab** → it disappears from the panel.
- **Switch active tab** (click another tab in the browser) → the dot/bold moves.
- The "原始标签页 JSON" region shows the initial snapshot, labeled with a timestamp. It does NOT change when tabs change (projected list does).
- Click "刷新" → re-fetches the snapshot; the raw-JSON timestamp updates.

- [ ] **Step 5: Manual smoke test — listener-leak check (Acceptance §10.7)**

In the side panel: rapidly switch between "标签页" and "文章" tabs 5+ times. Then switch to "标签页", open 3 new browser tabs, and close them. Verify the panel shows exactly the right tabs — no duplicate entries, no stale entries.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/entrypoints/sidepanel/TabsTab.tsx apps/extension/entrypoints/sidepanel/SidePanel.tsx
git commit -m "feat(extension): add tabs view with real-time updates and raw-JSON debug"
```

---

### Task 7: Final acceptance run + WS-independence verification

**Files:**
- None (verification only).

- [ ] **Step 1: Full acceptance walk-through (spec §10)**

With the desktop app **not running** (no WS host), load the extension and verify:

1. ✅ Tab switcher (文章 / 书签 / 标签页) visible — no WS needed.
2. ✅ "书签" shows the bookmarks tree, expand/collapse, refresh, raw JSON.
3. ✅ "标签页" shows all windows' tabs, updates live, refresh, raw JSON.
4. ✅ "文章" shows the token form (disconnected, as expected).

Then start the desktop app, paste the token, and verify:
5. ✅ "文章" connects and the article collect/list/analysis works as before (zero regression).

- [ ] **Step 2: SW-restart self-recovery test**

With the side panel open on "标签页":
- Navigate to `chrome://extensions`, find SwarmAgents, note the service worker status.
- Wait for the SW to go idle (or click "Service Worker" to inspect; let it sleep ~30s).
- Open/close a browser tab during the idle window.
- Click "刷新" in the tabs tab → verify it returns the current full state.

- [ ] **Step 3: Run the full test suite one final time**

Run: `pnpm --filter @swarm/extension run test`
Expected: PASS — bookmarks (3) + tabs-store (7) + existing extract/transport-ws tests.

Run: `pnpm --filter @swarm/extension run build`
Expected: PASS.

- [ ] **Step 4: Final commit (if any cleanup needed)**

If no code changes are needed, this task produces no commit. If verification surfaced a fix, commit it with a clear message.

---

## Self-Review

**1. Spec coverage:**
- §2 Goal 1 (bookmarks tree view) → Task 3 ✅
- §2 Goal 2 (tabs view, real-time) → Tasks 4+5+6 ✅
- §2 Goal 3 (raw-JSON debug) → Task 2 (RawJson) + Tasks 3, 6 ✅
- §2 Goal 4 (tab switcher without WS) → Task 1 (shell) ✅
- §2 Goal 5 (zero article regression) → Task 1 ✅
- §2 Goal 6 (no desktop/protocol changes) → all tasks touch only `apps/extension` ✅
- §4.4 (bookmarks direct, no background) → Task 3 BookmarksTab calls `getBookmarks()` directly ✅
- §5 (lazy init, SW restart recovery) → Task 4 store + Task 7 Step 2 verification ✅
- §6 (message protocol) → Task 5 ✅
- §7.3 (raw = unmodified API payload) → Task 2 RawJson contract + Tasks 3, 6 pass raw ✅
- §10 Acceptance criteria → Task 7 ✅

**2. Placeholder scan:** No TBD/TODO/"implement later". Task 4 originally had a drafting artifact (the first factory version was corrected inline) — the final file content in Step 4 is the corrected, complete factory. No unfixed placeholders remain.

**3. Type consistency:** `TabInfo`, `WindowTabs`, `TABS_MSG`, `TabsChangedKind`, `TabsChangedMessage` defined in `tabs-shared.ts` (Task 4 Step 1) and consumed identically in `tabs-store.ts`, `background.ts` (Task 5), and `TabsTab.tsx` (Task 6). `BookmarkNode` defined in `bookmarks.ts` (Task 3 Step 3) and consumed in `BookmarksTab.tsx` (Task 3 Step 5). `RawJson({ data, label })` signature consistent across Tasks 2, 3, 6.
