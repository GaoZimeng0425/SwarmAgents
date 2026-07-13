# Extension: View Article Analysis in Side Panel — Implementation Plan

> **For agentic workers:** This plan completes an in-progress feature. The
> side panel UI already exists (uncommitted in the working tree); this plan
> adds the missing background handlers + event forwarding that the UI depends
> on, then commits everything together. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let the browser extension's side panel list collected articles and
show each article's AI analysis (read-only) — without switching to desktop.

**Architecture:** All data flows over the existing loopback WS via the
background service worker. The side panel sends runtime messages to the
background (`listArticles`, `getArticleAnalysis`); the background forwards
them as WS RPCs via the existing `ServiceClient`. Analysis progress arrives
as `article.analysis*` broadcast events (transparently bridged service→WS
peer), which the background must re-broadcast as runtime messages so the
panel can refresh live. Triggering an analysis still happens on desktop
(which owns the provider/apiKey) — the panel is read-only.

**Tech Stack:** Chrome MV3 (WXT), `@swarm/protocol` ServiceClient over WS,
React 19 side panel.

## Current State (read this before starting)

The working tree has **uncommitted** changes to `SidePanel.tsx` that already
implement the full UI (article list + detail/analysis view). It sends three
messages the background doesn't handle yet:

- `{ type: 'listArticles' }` → expects `{ ok: true, articles } | { ok: false, error }`
- `{ type: 'getArticleAnalysis', articleId }` → expects `{ ok: true, summary, analyzedAt } | { ok: false, error }`
- Listens for `article.analysisComplete` runtime messages (forwarded from WS events)

The background (`apps/extension/entrypoints/background.ts`) currently handles
only `health`, `listAgents`, `collectCurrentPage`. It does NOT handle
`listArticles` / `getArticleAnalysis`, and its `onEvent` callback (line ~43)
only `console.log`s events instead of forwarding them to the panel.

**So the feature is currently broken: open the panel, it shows no articles
because `listArticles` gets no response.**

There are also unrelated uncommitted changes in `apps/desktop/src/main/gmail/**`
and a few other files — **do NOT touch or commit those**. Only stage the
extension files this plan modifies.

## Global Constraints

- **Language:** Code comments and commit messages in English only.
- **Surgical:** Only stage `apps/extension/**` files. Leave the gmail/desktop
  working-tree changes untouched.
- **No new deps.** `ServiceClient` already has `listArticles` / `getArticleAnalysis`.
- **`--no-verify` on commits** is acceptable: the repo has a pre-existing
  `packages/ui` typecheck debt (scroll-area.tsx unused React) unrelated to
  this work that blocks the pre-commit hook. Verify via
  `pnpm --filter @swarm/extension run typecheck` + `build` instead.
- TypeScript strict; the extension has `/// <reference types="chrome" />` at
  the top of background.ts (keep it).

---

## File Structure

**Modify:**
- `apps/extension/entrypoints/background.ts` — add 2 message handlers + event forwarding
- `apps/extension/entrypoints/sidepanel/SidePanel.tsx` — already done (just commit); review for correctness

**No new files.**

---

## Task 1: background.ts — add listArticles + getArticleAnalysis handlers

**Files:**
- Modify: `apps/extension/entrypoints/background.ts`

**Interfaces:**
- Consumes: `client.listArticles(): Promise<CollectedArticleWithAnalysis[]>` and `client.getArticleAnalysis(articleId): Promise<{ summary: ArticleSummary | null; analyzedAt: string | null }>` from `@swarm/protocol` (already exist on ServiceClient).
- Produces: two new branches in the `browser.runtime.onMessage` listener.

The existing listener (around line 78) has this structure:

```ts
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if ((msg as { type?: string })?.type === 'health') { ... ; return true }
  if ((msg as { type?: string })?.type === 'listAgents' && client) { ... ; return true }
  if ((msg as { type?: string })?.type === 'collectCurrentPage' && client) { ... ; return true }
  return false
})
```

- [ ] **Step 1: Add the `listArticles` branch**

Insert it after the `listAgents` branch and before `collectCurrentPage`. Mirror
the exact async-IIFE + `sendResponse` + `return true` pattern of `listAgents`:

```ts
    if ((msg as { type?: string })?.type === 'listArticles' && client) {
      ;(async () => {
        try {
          const articles = await client.listArticles()
          sendResponse({ ok: true, articles })
        } catch (err) {
          sendResponse({ ok: false, error: String(err) })
        }
      })()
      return true // async response
    }
```

- [ ] **Step 2: Add the `getArticleAnalysis` branch**

Insert it right after the `listArticles` branch:

```ts
    if ((msg as { type?: string })?.type === 'getArticleAnalysis' && client) {
      const articleId = (msg as { articleId?: string }).articleId
      ;(async () => {
        try {
          if (!articleId) {
            sendResponse({ ok: false, error: 'missing articleId' })
            return
          }
          const r = await client.getArticleAnalysis(articleId)
          sendResponse({ ok: true, summary: r.summary, analyzedAt: r.analyzedAt })
        } catch (err) {
          sendResponse({ ok: false, error: String(err) })
        }
      })()
      return true // async response
    }
```

- [ ] **Step 3: Verify the branches are mutually exclusive on `msg.type`**

Each `if` checks a distinct `type` value (`health` / `listAgents` / `listArticles`
/ `getArticleAnalysis` / `collectCurrentPage`), so only one fires per message.
The `&& client` guard is preserved (matches existing convention — drops the
message silently if the WS client isn't connected; the panel's health retry
will re-trigger fetches once connected).

---

## Task 2: background.ts — forward article.analysis* events to the side panel

**Files:**
- Modify: `apps/extension/entrypoints/background.ts` (the `onEvent` callback around line 43)

**Why:** The WS bridge transparently forwards service broadcast events to the
peer (extension). `ServiceClient`'s `onEvent(event, data)` callback receives
them. Currently it only `console.log`s. The side panel needs
`article.analysisComplete` (and ideally `article.analysisDelta`/`Error`) to
arrive as runtime messages so it can update the open article's analysis live
(as the desktop runs it).

- [ ] **Step 1: Replace the `onEvent` console.log with a forward**

Find this line inside `connect()`:

```ts
    onEvent: (e, d) => console.log('[swarm-ext] event', e, d),
```

Replace with:

```ts
    onEvent: (event, data) => {
      // Forward article analysis broadcasts to the side panel so it can update
      // the open article's analysis live. Other events (run.*, gmail.*, etc.)
      // are not relevant to the panel — drop them silently.
      if (typeof event === 'string' && event.startsWith('article.')) {
        void browser.runtime.sendMessage({ type: event, ...(data as object) })
      }
    },
```

**Why `void ...sendMessage`:** the forward is fire-and-forget; if no panel is
open, `sendMessage` resolves with `undefined` (no listener) — that's fine.
Casting `data as object` because the spread needs an object and `data` is
`unknown` from the transport.

**Note on the panel side:** the SidePanel already listens for
`msg?.type === 'article.analysisComplete'` with `articleId` + `summary` fields
(see its `useEffect` at line ~107). The forward above spreads `data` (which
carries `{ articleId, summary, ts }` per the protocol), so the field names
match. `article.analysisDelta`/`Error` are forwarded too but the current panel
doesn't react to them — that's acceptable (future enhancement).

- [ ] **Step 2: Confirm `browser.runtime.sendMessage` with no listeners doesn't throw**

In MV3, `browser.runtime.sendMessage` when no listener exists rejects with
"Could not establish connection" / "Receiving end does not exist" — but only
if you `await`/`.catch` it. The `void` prefix discards the rejected promise
(unhandled-rejection in some runtimes). To be safe, attach a `.catch`:

```ts
      if (typeof event === 'string' && event.startsWith('article.')) {
        browser.runtime.sendMessage({ type: event, ...(data as object) }).catch(() => {
          /* no panel open — ignore */
        })
      }
```

(Use this `.catch` version instead of the `void` version from Step 1.)

---

## Task 3: Verify the SidePanel UI is correct (review, don't rewrite)

**Files:**
- Review: `apps/extension/entrypoints/sidepanel/SidePanel.tsx` (already modified in the working tree)

- [ ] **Step 1: Read the current SidePanel.tsx and confirm the message contract matches**

The panel sends:
- `{ type: 'health' }` → `{ ok: true, count } | { ok: false, error }` ✓ (background already handles)
- `{ type: 'listArticles' }` → `{ ok: true, articles: CollectedArticleWithAnalysis[] } | { ok: false, error }` ✓ (Task 1 adds)
- `{ type: 'getArticleAnalysis', articleId }` → `{ ok: true, summary, analyzedAt } | { ok: false, error }` ✓ (Task 1 adds)
- `{ type: 'collectCurrentPage' }` → already handled

It listens for `article.analysisComplete` runtime messages ✓ (Task 2 forwards).

- [ ] **Step 2: Spot-check the panel renders analysis fields correctly**

`ArticleSummary` is `{ gist: string, points: string[], takeaways: string[] }`.
Confirm the detail view renders `gist`, `points` (list), `takeaways` (list).
If the existing code references fields that don't exist on these types, fix
them — but if it's correct, change nothing.

- [ ] **Step 3: Do NOT rewrite the panel**

It's already written. Only fix actual bugs you find in Step 2. Resist
refactoring.

---

## Task 4: Typecheck + build

- [ ] **Step 1: Extension typecheck**

```bash
pnpm --filter @swarm/extension run typecheck
```

Expected: clean (no output). If `chrome` is undefined, confirm the
`/// <reference types="chrome" />` is still at the top of background.ts.

- [ ] **Step 2: Extension build**

```bash
pnpm --filter @swarm/extension run build
```

Expected: succeeds, produces `.output/chrome-mv3/`. The background.js should
now contain the `listArticles` / `getArticleAnalysis` handlers.

- [ ] **Step 3: Confirm no stray type errors introduced**

If typecheck fails on something other than background.ts, read the error — it
may be a pre-existing issue in the working tree (e.g. the gmail files). Do
NOT fix unrelated files; only ensure background.ts + SidePanel.tsx are clean.

---

## Task 5: Commit (staging ONLY extension files)

- [ ] **Step 1: Confirm which files changed**

```bash
git status --porcelain -- apps/extension
```

Should show:
- `M apps/extension/entrypoints/background.ts`
- `M apps/extension/entrypoints/sidepanel/SidePanel.tsx`

(The SidePanel change was already in the working tree; background.ts is the
new work. If there are other modified extension files, investigate before
staging.)

- [ ] **Step 2: Stage ONLY extension files**

```bash
git add apps/extension/entrypoints/background.ts apps/extension/entrypoints/sidepanel/SidePanel.tsx
```

**Critical:** Do NOT `git add -A` or `git add apps/` — there are unrelated
gmail/desktop working-tree changes that must stay uncommitted.

- [ ] **Step 3: Confirm the staged set is exactly the two files**

```bash
git diff --cached --name-only
```

Expected: exactly those two paths. If anything else appears, unstage it.

- [ ] **Step 4: Commit with --no-verify**

```bash
git commit --no-verify -m "feat(extension): list articles + view analysis in side panel

The side panel now shows the collected-article list and each article's AI
analysis (read-only). background handles listArticles / getArticleAnalysis
RPCs over the existing WS, and forwards article.analysis* broadcasts to the
panel so a running analysis (triggered on desktop) updates live. Triggering
an analysis still happens on desktop, which owns the provider."
```

- [ ] **Step 5: Verify the commit**

```bash
git log --oneline -1
git show --stat HEAD
```

Confirm exactly 2 files changed. The pre-existing gmail/ui working-tree
changes should still show as unstaged (`git status`).

---

## Manual Smoke Test (hand off to the user)

After committing, the user tests:

1. Reload the extension (`chrome://extensions` → 🔄).
2. Open the side panel → should show "已收集 N 篇" with the article list
   (if articles exist on desktop).
3. Click an article → detail view shows title/site/date + (if analyzed) the
   gist/points/takeaways, or "这篇文章还没有分析" if not.
4. On desktop, open the same article and click "AI 分析" → the side panel's
   open detail view should update live when the analysis completes
   (forwarded `article.analysisComplete` event).
5. "收集当前页" still works (unchanged).

If the list is empty but desktop has articles: check the background service
worker console (`chrome://extensions` → SwarmAgents → "service worker") for
errors from the `listArticles` handler.

---

## Self-Review (run before declaring done)

1. **Spec coverage:** background has `listArticles` + `getArticleAnalysis`
   handlers ✓; `onEvent` forwards `article.*` events ✓; SidePanel committed ✓.
2. **No collateral:** `git diff --cached --name-only` shows only the 2
   extension files; gmail/desktop working-tree changes untouched.
3. **Type safety:** `CollectedArticleWithAnalysis` / `ArticleSummary` imported
   from `@swarm/protocol` where referenced.
4. **Event field match:** forwarded event spreads `data` which carries
   `{ articleId, summary, ts }` — matches what the panel's listener reads
   (`msg.articleId`, `msg.summary`).
5. **`.catch` on forward:** the `sendMessage` won't throw an unhandled
   rejection when no panel is open.
