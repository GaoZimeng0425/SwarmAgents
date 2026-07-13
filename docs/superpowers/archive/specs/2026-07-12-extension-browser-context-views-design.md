# Extension Browser-Context Views (Bookmarks + Tabs) — Design

**Status:** Proposed
**Date:** 2026-07-12
**Scope:** Add two read-only browser-context views (bookmarks, open tabs) to the
existing SwarmAgents Chrome extension's side panel, plus an inline raw-JSON
debug surface for each. No desktop/protocol changes.

---

## 1. Background & Motivation

The extension (`apps/extension`) is a Chrome MV3 (WXT) remote client over the
desktop's loopback WS host. Its side panel today has a single concern: collect
the current page as an article and view collected articles + their AI analysis.

The user wants the extension to also act as a **browser-context viewer** —
surface the browser's bookmarks and currently-open tabs inside the same side
panel, with a lightweight debug affordance (raw JSON) for each. This is a pure
extension feature: it touches only `chrome.bookmarks` / `chrome.tabs` APIs, has
no dependency on the WS connection or the agent runtime, and does not enter the
agent tool chain.

### Existing structure (relevant slices)

- `entrypoints/background.ts` — MV3 service worker: owns the WS client
  (keepalive alarm + reconnect) and routes `runtime.onMessage` for `health`,
  `collectCurrentPage`, `listAgents`.
- `entrypoints/sidepanel/SidePanel.tsx` — single React view: health probe loop,
  token form (disconnected), collect button + article list + analysis detail
  (connected).
- `entrypoints/extract.content.ts` — content script that extracts article DOM.
- `lib/transport-ws.ts` — browser `WebSocket` → `ServiceTransport`.
- `wxt.config.ts` — manifest via WXT; `permissions: ['storage','alarms','scripting']`.

The symmetric RPC model (`registerHandler` in `@swarm/protocol`) would let the
extension register handlers the agent could call back — but this design
**deliberately does not use it**. Bookmarks/tabs are a viewer, not an agent tool.

---

## 2. Goals

1. **Bookmarks view** in the side panel: tree-structured (expand/collapse),
   reflecting the Chrome bookmarks hierarchy, with manual refresh.
2. **Tabs view** in the side panel: all non-incognito windows' tabs, updating
   in real time while the panel is open.
3. **Raw-JSON debug surface** for each view (a collapsible region showing the
   unmodified `chrome.*` API return value).
4. **Tab switcher** in the side panel that is available **without** a WS
   connection — bookmarks/tabs are independent of the desktop runtime.
5. **Zero regression** on the existing article-collection behavior.
6. **No desktop or protocol changes.** Everything lives in `apps/extension`.

## 3. Non-Goals

- **No incognito-window tabs.** `chrome.tabs.query({})` does not return
  incognito tabs under the extension's default split mode; supporting them
  requires an incognito access mode change — out of scope for v1. The
  `WindowTabs.incognito` field is retained but always `false` today.
- **No per-tab actions** (send-to-agent, collect-as-article). The tabs view is
  read-only viewing/debugging only.
- **No agent-tool integration.** The extension does not register any
  `MainMethod` handler for bookmarks/tabs; the agent cannot invoke these.
- **No real-time bookmark updates.** `bookmarks.onCreated` / `onRemoved` /
  `onChanged` listeners are not wired — manual refresh is sufficient.
- **No full-field tab table.** A projected model drives the rendered list; the
  raw API payload lives in the raw-JSON region. Two layers, nothing between.
- **No UI tests.** The extension has no UI test harness today; raw logic is
  unit-tested, UI is manually verified (matches the existing extension's
  stance — `background.ts`'s `health`/`collectCurrentPage` have no unit tests).

---

## 4. Architecture

### 4.1 Side-panel layout

```
┌─ SidePanel ──────────────────────────┐
│  Health probe (retained, tab-agnostic)│
│                                        │
│  Disconnected & on Articles tab →     │
│    token form (retained as-is)        │
│                                        │
│  Tab switcher (always visible):       │
│    [文章] [书签] [标签页]              │
│                                        │
│  activeTab === 'articles'  → <ArticlesTab/>
│  activeTab === 'bookmarks' → <BookmarksTab/>
│  activeTab === 'tabs'      → <TabsTab/>  │
└────────────────────────────────────────┘
```

The tab switcher is shown **unconditionally** (not gated on WS connection).
Bookmarks and tabs work with no desktop running. The Articles tab, when
disconnected, shows the existing token form; when connected, shows the article
list/detail — exactly as today.

### 4.2 Responsibilities

| Unit | Role | Depends on |
|---|---|---|
| `lib/bookmarks.ts` | Call `chrome.bookmarks.getTree()`, project to `BookmarkNode[]` tree. Pure data transform, no React. | `chrome.bookmarks` |
| `lib/tabs-store.ts` | Background-side tabs state machine: `loadAll()` full snapshot, `tabs.on*` incremental upsert/remove, `subscribe()`/`snapshot()`. | `chrome.tabs` |
| `BookmarksTab.tsx` | Tree render (expand/collapse), manual refresh, `<RawJson/>`. Calls `chrome.bookmarks.getTree()` directly. | `lib/bookmarks.ts`, `RawJson` |
| `TabsTab.tsx` | Tabs grouped by window, real-time updates via background messages, manual refresh, `<RawJson/>`. | background messages, `RawJson` |
| `ArticlesTab.tsx` | Existing article logic extracted verbatim from SidePanel — zero behavior change. | `@swarm/protocol` (existing) |
| `RawJson.tsx` | Shared collapsible `<details>` + `<pre>` raw-JSON region; receives the **raw** API payload, not the projection. | React |

### 4.3 Why tabs events live in the background (chosen approach)

MV3 recycles the service worker after ~30s idle and destroys the side panel
when the user closes it. Tabs change events must be captured by the
long-lived-as-possible background SW so that:

- While the panel is open, the SW is kept alive (by the existing keepalive
  alarm + now also by active event traffic) and captures every `tabs.on*`.
- If the panel is closed and reopened, it re-requests a snapshot from the
  background store, which transparently re-initializes if the SW was GC'd.

The alternative (listeners in the panel) loses events while the panel is closed
and was rejected per the user's decision (approach A: background listens).

### 4.4 Why bookmarks do NOT go through the background

There is no real-time requirement for bookmarks, so there is no reason to
relay `getTree()` through the background. The `BookmarksTab` calls
`chrome.bookmarks.getTree()` directly and projects the result via
`lib/bookmarks.ts`. This keeps the background free of bookmark state.

---

## 5. Background tabs state machine (`lib/tabs-store.ts`)

### 5.1 Lifecycle

```
SW starts / wakes (onInstalled | onStartup | alarm)
   │
   ├─ store uninitialized until first consumer asks
   │
   ├─ listeners registered (idempotent — chrome.* dedupes):
   │    tabs.onCreated   → upsert(tab)
   │    tabs.onUpdated   → merge changeInfo into existing, upsert
   │    tabs.onRemoved   → remove(tabId)
   │    tabs.onAttached  → update windowId ownership
   │    tabs.onActivated → mark active tab per window
   │
   └─ panel subscribes → replay current snapshot, then push deltas
```

### 5.2 Lazy initialization & SW-restart self-recovery

The store is **lazy**: it does not call `loadAll()` on SW boot. It initializes
on the first `snapshot()` request from a panel. Rationale: the SW is GC'd and
rewoken frequently; eagerly loading on every wake wastes work when no panel is
open.

On SW restart (GC + rewoken), in-memory state is gone. The next
`tabs:getSnapshot` message finds the store uninitialized and calls `loadAll()`
again. To the panel this is transparent — it always receives a complete
snapshot. This is why the panel model is "pull snapshot + listen for deltas",
never "pure push".

### 5.3 Pushing deltas to the panel

The store maintains tabs state; the **background message layer** (the existing
`runtime.onMessage` handler in `background.ts`) decides when to forward deltas
to the panel. When a `tabs:getSnapshot` request arrives, the background marks
a panel as "listening" (a simple boolean). While listening is true, each
`tabs.on*` handler updates the store and the background sends a `tabs:changed`
message to the panel. When the subscriber set is empty (no panel has asked for
a snapshot since the SW started), `chrome.tabs.on*` still fire and update the
store (cheap), but no message is sent — no work wasted on a closed panel.

There is exactly one panel; the "listening" flag is a single boolean, not a
multi-subscriber registry. The flag resets naturally when the SW is GC'd — the
panel's next `tabs:getSnapshot` re-establishes it. The panel does not call
`store.subscribe()` directly; the background bridges store state to
`runtime.sendMessage`. Listeners on `chrome.tabs.*` are registered once
(chrome.* dedupes identical references) and kept for the SW's lifetime.

---

## 6. Message protocol (background ↔ panel)

Reuses the existing `runtime.onMessage` pattern (`type`-routed, async
`sendResponse`, `return true`) established by `health` / `collectCurrentPage`.

| Direction | `type` | Payload | When |
|---|---|---|---|
| panel → bg | `tabs:getSnapshot` | none | `TabsTab` mounts |
| bg → panel | `tabs:snapshot` | `{ windows: WindowTabs[] }` | response to `getSnapshot` |
| bg → panel | `tabs:changed` | `{ kind: 'created'\|'updated'\|'removed'\|'activated'; tab: TabInfo }` | each `tabs.on*` |
| bg → panel | `tabs:snapshotError` | `{ error: string }` | `getSnapshot`'s catch |

Bookmarks have **no** messages — `BookmarksTab` calls `chrome.bookmarks.getTree()`
directly.

The `tabs:changed` deltas are applied by the panel to its local copy of the
last snapshot. Because the panel always starts from a full `tabs:snapshot`, the
local copy is consistent; deltas only ever reference tab ids that exist in it
(created adds, removed deletes, others update existing).

---

## 7. Data models

### 7.1 Tabs (projected for rendering)

```typescript
// A slim projection of chrome.tabs.Tab — only what the view/debug needs.
type TabInfo = {
  id: number
  windowId: number
  title: string
  url: string
  favIconUrl?: string
  active: boolean // whether this tab is the active tab of its window
}

// Tabs grouped by window, the shape the UI renders.
type WindowTabs = {
  windowId: number
  incognito: boolean // retained; always false in v1 (no incognito access)
  tabs: TabInfo[]
}
```

### 7.2 Bookmarks (projected for rendering)

```typescript
// A subset of chrome.bookmarks.BookmarkTreeNode preserving the hierarchy.
type BookmarkNode = {
  id: string
  title: string
  url?: string // absent => folder
  children?: BookmarkNode[]
  dateAdded?: number
}
```

### 7.3 Raw payloads

The `<RawJson/>` regions receive the **unmodified** `chrome.tabs.query()`
result (array of full `chrome.tabs.Tab`) and `chrome.bookmarks.getTree()`
result (array of full `chrome.bookmarks.BookmarkTreeNode`), respectively —
not the projections. This is the contract that makes the debug surface
trustworthy: what you see is exactly what the API returned.

---

## 8. UI component detail

### 8.1 `RawJson.tsx`

```tsx
function RawJson({ data, label }: { data: unknown; label: string }) {
  return (
    <details className="...">
      <summary className="cursor-pointer select-none text-xs ...">{label}</summary>
      <pre className="overflow-x-auto text-[10px] ...">{JSON.stringify(data, null, 2)}</pre>
    </details>
  )
}
```

Native `<details>` gives expand/collapse semantics for free. `<pre>` preserves
JSON indentation. Lazy rendering is unnecessary — these payloads are small.

### 8.2 `BookmarksTab.tsx`

- **Mount / refresh:** `chrome.bookmarks.getTree()` → `toBookmarkNodes(raw)` →
  set `tree` (projected) and `rawTree` (raw, for `RawJson`).
- **Header:** refresh button + bookmark count.
- **Body:** recursive tree render. Folders are expand/collapse toggles; their
  expand state is a local `Set<string>` of node ids (first-level "书签栏" /
  "其他书签" expanded by default). Leaf bookmarks show title, hostname, and
  a relative dateAdded.
- **Footer:** `<RawJson label="原始书签 JSON" data={rawTree} />`.

### 8.3 `TabsTab.tsx`

- **Mount:** send `{ type: 'tabs:getSnapshot' }`; on `tabs:snapshot`, store
  `windows` (projected) and `rawSnapshot` (raw). Subscribe to `tabs:changed`.
- **`tabs:changed` handling:** by `kind` — `created`/`updated` upsert the
  `TabInfo` into its window group (creating the group if new, i.e. a new
  window); `removed` deletes the `TabInfo` and drops the window group if empty;
  `activated` flips the `active` flag within the window. The projected render
  updates live; the **raw-JSON region stays static** (it shows the initial
  `tabs:snapshot` payload, labeled with a timestamp — see §14).
- **Unmount:** remove the `runtime.onMessage` listener. **Must use a named
  function reference** for the listener, not an inline arrow — inline arrows
  cannot be removed and leak (Acceptance §10.7).
- **Header:** refresh button (re-sends `getSnapshot`) + total tab count.
- **Body:** per-window collapsible section ("窗口 N · 普通/隐身") listing
  tabs: title, hostname, active badge.
- **Footer:** `<RawJson label="原始标签页 JSON" data={rawSnapshot} />`.

### 8.4 `SidePanel.tsx` (shell, after refactor)

Retains: the health-probe `useEffect`, the token form (now scoped to the
Articles tab when disconnected). Adds: `const [activeTab, setActiveTab] =
useState<'articles'|'bookmarks'|'tabs'>('articles')` and a tab switcher row,
plus conditional rendering of the three tab components. The tab switcher is
**always** rendered (not gated on connection).

### 8.5 `ArticlesTab.tsx`

The existing SidePanel article logic — `collecting`, `collectStatus`,
`articles`, `listError`, `selectedId`, `analysis`, and all effects — moves here
verbatim. The only inputs it needs from the shell are `connected` (to decide
form vs. list) and the same `browser.runtime.sendMessage` plumbing it already
uses. Zero behavior change.

---

## 9. Manifest changes

`wxt.config.ts`:

```typescript
permissions: ['storage', 'alarms', 'scripting', 'bookmarks', 'tabs'],
```

`bookmarks` and `tabs` are standard MV3 permissions; they take effect on
unpacked-load with no user grant step. `host_permissions` is unchanged —
reading all windows' tabs needs only the `tabs` permission, no extra host
grants.

---

## 10. Acceptance criteria

The feature is complete when **all** hold:

1. The side panel has a tab switcher (文章 / 书签 / 标签页) that is usable
   **without** a WS connection — bookmarks and tabs work with the desktop not
   running.
2. **Bookmarks:** tree render, expand/collapse, manual refresh, raw-JSON
   region.
3. **Tabs:** all non-incognito windows' tabs, real-time updates while the panel
   is open, manual refresh, raw-JSON region.
4. **Article feature zero-regression:** collect, list, analysis-detail behavior
   unchanged.
5. `lib/bookmarks.test.ts` and `lib/tabs-store.test.ts` pass.
6. `pnpm --filter @swarm/extension run build` succeeds; the
   `.output/chrome-mv3` artifact loads as unpacked and all three views work.
7. **No listener leak:** rapidly switching away from and back to the Tabs tab,
   opening/closing several pages, produces no duplicate entries in the panel.

---

## 11. Edge cases

| Case | Handling |
|---|---|
| SW GC'd while panel open | Next `tabs:getSnapshot` finds store uninitialized → `loadAll()` again; transparent full snapshot returned. |
| Panel closed, SW alive, tabs change | Store still updates (no subscribers → no send); next snapshot reflects latest. |
| Incognito-window tabs | Not returned by `chrome.tabs.query({})` under split mode; out of scope (Non-Goal §3). `WindowTabs.incognito` retained but always false. |
| Empty bookmarks tree | Render "没有书签"; raw JSON shows `[]`. |
| Tab title/url empty (page loading) | Placeholder "(加载中)", url blank. |
| `chrome.tabs.query` fails right after SW wake (rare race) | `tabs:getSnapshot` catch returns `tabs:snapshotError`; panel shows "快照获取失败" with a retry button. |
| Switching away from TabsTab mid-stream | `useEffect` cleanup removes the named `onMessage` listener; no orphaned callbacks accumulate. |

---

## 12. Test strategy

**Unit-tested (pure logic, in `lib/*.test.ts` per extension convention):**

- `lib/bookmarks.test.ts` — `chrome.bookmarks.getTree()` raw → `BookmarkNode[]`:
  folders retain children, empty folders, deep nesting, `dateAdded` pass-through.
  Feed fake `BookmarkTreeNode` fixtures.
- `lib/tabs-store.test.ts` — tabs-store state machine: `loadAll` produces a
  complete snapshot; each of `onCreated`/`onUpdated`/`onRemoved`/`onActivated`
  applies the correct delta; subscribers are invoked on change; lazy
  re-initialization after a simulated SW restart yields a fresh snapshot.
  Fake `chrome.tabs`.

**Not unit-tested (manual verification):**
- The background↔panel message bridge (`runtime.onMessage` glue) — matches the
  existing extension's stance (`health`/`collectCurrentPage` have no unit tests).
- UI rendering — no UI test harness in the extension today; not introduced here.

---

## 13. Migration / sequencing

Each step is independently verifiable; land as separate commits on a dedicated
branch/worktree (per `AGENTS.md` §6).

1. **Extract `ArticlesTab`** — move article logic out of `SidePanel.tsx`
   verbatim; shell renders it. → verify: article behavior unchanged, build
   green.
2. **Add tab switcher shell** — `activeTab` state + switcher row + empty
   `BookmarksTab`/`TabsTab` placeholders. → verify: switching works, no WS
   needed.
3. **`lib/bookmarks.ts` + `BookmarksTab`** — tree render + raw JSON. Add
   `bookmarks` permission. → verify: bookmarks render; unit test passes.
4. **`lib/tabs-store.ts` + background wiring + `TabsTab`** — snapshot +
   real-time deltas + raw JSON. Add `tabs` permission. → verify: tabs render
   and update live; unit test passes.
5. **Manual acceptance run** — walk §10's checklist.

---

## 14. Decision: raw-JSON freshness in TabsTab

**Decision (A):** the tabs raw-JSON region shows the **initial** `tabs:snapshot`
payload statically, labeled with a fetch timestamp. Live `tabs:changed` deltas
update only the projected render, not the raw region.

Rationale: the raw region is a debug aid meant to show exactly what the API
returned. Re-deriving it from the lossy projection would misrepresent the API
shape (§7.3), and re-querying on every delta adds churn for no debugging value.
A timestamp-labeled point-in-time snapshot is honest and sufficient.
