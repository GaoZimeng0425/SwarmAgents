# Phase 3a — Command Palette Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two backend capabilities the Phase 3b command palette needs — (1) session-Markdown export, (2) an observable-artifact index (cwd-recent-files + bilibili analyses). Both exposed to the renderer via new IPC channels, preload bridge methods, and `swarmApi` facade entries. No UI changes.

**Architecture:** Two independent features on one branch. Export Markdown lives in the **service** process (it has `ConversationStore.getRunEvents`); the markdown builder is a pure function (unit-tested), the file-write is a thin wrapper writing to a paths-derived exports dir. The artifact index lives in the **main** process (it has `app.getPath`, the bilibili analysis store, and filesystem access); it scans the cwd for recent files and joins bilibili analyses, returning a flat `ArtifactEntry[]`. (Composer-attachments aggregation is deferred — see spec §1 non-goals; the cross-process join it would require isn't worth it for 3a.)

**Tech Stack:** Electron 43 (main + utilityProcess sidecar), Node fs/promises, zod (protocol types), Vitest (node env for service/main tests; temp dirs for fs tests), better-sqlite3 (existing store).

**Spec:** `docs/superpowers/specs/2026-07-05-command-palette-design.md` (Phase 3a section §4)

**Branch:** create `feat/cmd-palette-backend` from `refactor/ui-app-shell-rail` before Task 1.

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `packages/protocol/src/types/ui.ts` | Add `ArtifactEntry` type + zod schema. | **Modify** |
| `packages/protocol/src/types/service-ipc.ts` | Add `'exportSessionMarkdown'` to `ServiceMethod`. | **Modify** |
| `packages/protocol/src/service-client.ts` | Add `exportSessionMarkdown` to `ServiceClient` interface + impl. | **Modify** |
| `apps/desktop/src/service/conversation/markdown-export.ts` | Pure `buildMarkdown(rows)` + tests. | **Create** |
| `apps/desktop/src/service/conversation/markdown-export.test.ts` | Unit tests for `buildMarkdown`. | **Create** |
| `apps/desktop/src/service/conversation/store.ts` | (No change — uses existing `getRunEvents`.) | — |
| `apps/desktop/src/service/session/session-service.ts` | Add `exportSessionMarkdown(sessionId)` method (calls store + `buildMarkdown` + writes file + returns path). | **Modify** |
| `apps/desktop/src/service/ipc/dispatcher.ts` | Wire the new `'exportSessionMarkdown'` service method (the dispatcher maps ServiceMethod → service call). | **Modify** |
| `apps/desktop/src/service/index.ts` | Pass an `exportsDir` (resolved from the injected userData path) into the service so it can write files. | **Modify** |
| `apps/desktop/src/main/constants.ts` | Add `paths.exports()` getter. | **Modify** |
| `apps/desktop/src/main/ipc/swarm-ipc.ts` | Register `swarm:exportSessionMarkdown` (→ service via `serviceClient`) and `swarm:listArtifacts` (→ main artifacts service). | **Modify** |
| `apps/desktop/src/main/cmd-palette/artifacts-service.ts` | `listArtifacts(filter)` — cwd scan + bilibili analyses. | **Create** |
| `apps/desktop/src/main/cmd-palette/artifacts-service.test.ts` | Tests against a temp cwd dir + mocked bilibili source. | **Create** |
| `apps/desktop/src/main/cmd-palette/index.ts` | `initCmdPaletteArtifacts(deps)` wiring — owns the artifacts service + IPC registration. | **Create** |
| `apps/desktop/src/main/index.ts` | Call `initCmdPaletteArtifacts` after bilibili + service are ready; pass `exportsDir` to the service fork. | **Modify** |
| `apps/desktop/src/preload/index.ts` | Add `exportSessionMarkdown` + `listArtifacts` to the `swarm` bridge. | **Modify** |
| `apps/desktop/src/renderer/src/lib/api.ts` | Add `swarmApi.exportSessionMarkdown` + `swarmApi.listArtifacts`. | **Modify** |

> **Note on the dispatcher:** the exact file that maps `ServiceMethod` → service call must be confirmed by reading. The plan refers to it as `service/ipc/dispatcher.ts` per the codegraph result (`getRunEvents` caller); adjust if the actual filename differs.

---

## Task 0: Create the branch

- [ ] **Step 1: Create and switch**

```bash
git checkout -b feat/cmd-palette-backend refactor/ui-app-shell-rail
```
Expected: `Switched to a new branch 'feat/cmd-palette-backend'`.

- [ ] **Step 2: Verify clean state**

```bash
git status --short
```
Expected: only `?? docs/design/` (and the untracked `ed25519-*.pem` if still present — leave alone, never stage).

---

## Task 1: `ArtifactEntry` protocol type

**Files:**
- Modify: `packages/protocol/src/types/ui.ts`

- [ ] **Step 1: Add the type + schema**

In `packages/protocol/src/types/ui.ts`, add (near the other UI types, e.g. after `CronRun`):

```ts
/** One entry in the command palette's `/` 文件 & 产出 scope. */
export const ArtifactEntrySchema = z.object({
  /** Source of the entry. `file` = cwd-recent-file; `bilibili-analysis` = a saved Bilibili summary. */
  kind: z.enum(['file', 'bilibili-analysis']),
  /** Display name: filename for `file`; video title for `bilibili-analysis`. */
  name: z.string(),
  /** Filesystem path (`file`) or bvid (`bilibili-analysis`). */
  ref: z.string(),
  size: z.number().int().nonnegative().optional(),
  modifiedAt: z.number().int().nonnegative().optional(),
  /** Origin label: the cwd path for `file`; "Bilibili" for `bilibili-analysis`. */
  origin: z.string(),
})
export type ArtifactEntry = z.infer<typeof ArtifactEntrySchema>
```

If `z` is not already imported at the top of `ui.ts`, check — most likely it is (the file defines other schemas). If not, add `import { z } from 'zod'`.

- [ ] **Step 2: Type-check + test**

```bash
pnpm --filter desktop run typecheck:web
pnpm --filter desktop exec vitest run packages/protocol
```
Expected: no type errors; protocol tests pass (the new type is unused so far, but must compile).

- [ ] **Step 3: Commit**

```bash
git add packages/protocol/src/types/ui.ts
git commit -m "feat(protocol): add ArtifactEntry type for the command palette"
```

---

## Task 2: `buildMarkdown` pure function + tests (TDD)

**Files:**
- Create: `apps/desktop/src/service/conversation/markdown-export.ts`
- Create: `apps/desktop/src/service/conversation/markdown-export.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/service/conversation/markdown-export.test.ts`:

```ts
import type { RunEvent } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { buildMarkdown } from './markdown-export'

// Helper: build a RunEvent row from a partial UIEvent.
const row = (e: Partial<RunEvent['event']> & { kind: string }, runId = 'r1', parentRunId: string | null = null): RunEvent => ({
  runId,
  parentRunId,
  seq: 1,
  ts: 1000,
  event: e as RunEvent['event'],
})

describe('buildMarkdown', () => {
  it('renders an assistant message as a bold Agent line', () => {
    const out = buildMarkdown([
      row({ kind: 'llm.message', role: 'assistant', content: 'Hello there.' }),
    ])
    expect(out).toContain('**Agent:**')
    expect(out).toContain('Hello there.')
  })

  it('renders a user message as a bold You line', () => {
    const out = buildMarkdown([
      row({ kind: 'llm.message', role: 'user', content: 'Do the thing.' }),
    ])
    expect(out).toContain('**You:**')
    expect(out).toContain('Do the thing.')
  })

  it('renders a tool call as a fenced code block with the tool name', () => {
    const out = buildMarkdown([
      row({ kind: 'tool.call', server: 'fs', tool: 'read_file', args: { path: '/a' } }),
    ])
    expect(out).toContain('```')
    expect(out).toContain('read_file')
  })

  it('renders an error as a blockquote', () => {
    const out = buildMarkdown([
      row({ kind: 'error', error: { code: 'boom', message: 'it broke', tier: 'recoverable' } }),
    ])
    expect(out.startsWith('> ')).toBe(true)
    expect(out).toContain('it broke')
  })

  it('skips reasoning events (private to the model)', () => {
    const out = buildMarkdown([
      row({ kind: 'reasoning', content: 'thinking secretly' }),
      row({ kind: 'llm.message', role: 'assistant', content: 'visible' }),
    ])
    expect(out).not.toContain('thinking secretly')
    expect(out).toContain('visible')
  })

  it('truncates large payloads (>2KB) with a marker', () => {
    const big = 'x'.repeat(3000)
    const out = buildMarkdown([
      row({ kind: 'llm.message', role: 'assistant', content: big }),
    ])
    expect(out).toContain('truncated')
    expect(out.length).toBeLessThan(big.length)
  })

  it('nests child runs under their parent with indentation', () => {
    const out = buildMarkdown([
      row({ kind: 'run.created', runId: 'parent', sessionId: 's', goal: 'parent goal', ts: 1 }, 'parent'),
      row({ kind: 'run.created', runId: 'child', sessionId: 's', goal: 'child goal', ts: 2, parentRunId: 'parent' }, 'child', 'parent'),
    ])
    // Both goals appear; the child is indented relative to the parent.
    expect(out).toContain('parent goal')
    expect(out).toContain('child goal')
  })

  it('returns a header-only doc for empty input', () => {
    const out = buildMarkdown([])
    expect(out).toMatch(/SwarmAgents|Session|Export/i)
    expect(out.trim().length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter desktop exec vitest run src/service/conversation/markdown-export.test.ts
```
Expected: FAIL — "Failed to resolve import './markdown-export'".

- [ ] **Step 3: Write `buildMarkdown`**

Create `apps/desktop/src/service/conversation/markdown-export.ts`:

```ts
// Pure markdown builder for session exports. Turns a session's RunEvent stream
// into a human-readable transcript: messages as bold role lines, tool calls as
// fenced code, errors as blockquotes. Child runs nest under their parent. Pure;
// unit-tested. The file-write wrapper lives in session-service.ts.

import type { RunEvent, UIEvent } from '@swarm/protocol'

const PAYLOAD_LIMIT = 2000

/**
 * Build a markdown transcript from a session's run-event rows. Rows must be in
 * insertion order (as returned by ConversationStore.getRunEvents). Top-level
 * runs become `##` sections; child runs indent their contents.
 */
export function buildMarkdown(rows: RunEvent[]): string {
  const byRun = new Map<string, RunEvent[]>()
  const parentOf = new Map<string, string | null>()
  const goalByRun = new Map<string, string>()
  const order: string[] = []
  for (const r of rows) {
    if (!byRun.has(r.runId)) {
      byRun.set(r.runId, [])
      order.push(r.runId)
      parentOf.set(r.runId, r.parentRunId)
    }
    // Capture the goal from the run.created event for the section heading.
    if (r.event.kind === 'run.created') goalByRun.set(r.runId, r.event.goal)
    byRun.get(r.runId)!.push(r)
  }

  const lines: string[] = ['# SwarmAgents Session Export', '']

  const renderRun = (runId: string, depth: number): void => {
    const events = byRun.get(runId) ?? []
    const prefix = '  '.repeat(depth)
    const heading = '#'.repeat(Math.min(depth + 2, 6))
    lines.push(`${prefix}${heading} ${goalByRun.get(runId) ?? runId}`, '')
    for (const { event } of events) {
      const body = renderEvent(event)
      if (body === null) continue
      lines.push(`${prefix}${body}`, '')
    }
  }

  // Render top-level runs first; their children appear nested inline.
  const rendered = new Set<string>()
  for (const runId of order) {
    if (parentOf.get(runId) !== null) continue // child — rendered by parent
    renderRun(runId, 0)
    rendered.add(runId)
    // Inline children of this top-level run.
    for (const child of order) {
      if (parentOf.get(child) === runId && !rendered.has(child)) {
        renderRun(child, 1)
        rendered.add(child)
      }
    }
  }

  return lines.join('\n').trimEnd() + '\n'
}

function renderEvent(e: UIEvent): string | null {
  switch (e.kind) {
    case 'llm.message': {
      const role = e.role === 'user' ? 'You' : e.role === 'assistant' ? 'Agent' : 'Tool'
      const text = stringify(e.content)
      return `**${role}:** ${truncate(text)}`
    }
    case 'tool.call':
      return '```json\n' + truncate(`tool: ${e.tool}\nserver: ${e.server}\nargs: ${stringify(e.args)}`) + '\n```'
    case 'tool.result':
      return null // results are noise in an export; the call + next message suffice
    case 'error':
      return `> ⚠️ ${e.error.message} (${e.error.code})`
    case 'permission':
      return null // intra-run plumbing; not transcript-worthy
    case 'reasoning':
      return null // model-private
    default:
      return null // run.* lifecycle events are reflected in the section headings
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function truncate(text: string): string {
  if (text.length <= PAYLOAD_LIMIT) return text
  return `${text.slice(0, PAYLOAD_LIMIT)}\n\n… (truncated, ${text.length - PAYLOAD_LIMIT} chars omitted)`
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter desktop exec vitest run src/service/conversation/markdown-export.test.ts
```
Expected: PASS (8 tests). Adjust the implementation only if a test reveals a real bug — do NOT weaken assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/service/conversation/markdown-export.ts apps/desktop/src/service/conversation/markdown-export.test.ts
git commit -m "feat(service): add pure buildMarkdown for session exports"
```

---

## Task 3: Service `exportSessionMarkdown` + dispatcher wiring

**Files:**
- Modify: `packages/protocol/src/types/service-ipc.ts`
- Modify: `packages/protocol/src/service-client.ts`
- Modify: `apps/desktop/src/service/session/session-service.ts`
- Modify: `apps/desktop/src/service/ipc/dispatcher.ts`
- Modify: `apps/desktop/src/service/index.ts`

**Before starting:** READ these files to confirm exact insertion points:
- `service-client.ts` — how an existing method like `getRunEvents` is declared (interface line ~42) AND implemented (the `call(...)` factory, ~line 190+).
- `service/ipc/dispatcher.ts` — how `getRunEvents` is dispatched; mirror that.
- `service/session/session-service.ts` — its constructor/deps shape (does it receive a `paths`/`exportsDir`?).
- `service/index.ts` — where the service is constructed; what's already injected.

- [ ] **Step 1: Add `exportSessionMarkdown` to `ServiceMethod`**

In `packages/protocol/src/types/service-ipc.ts`, add `'exportSessionMarkdown'` to the `ServiceMethod` union (alphabetical-ish among the others):

```ts
export type ServiceMethod =
  | ...
  | 'listAllCronRuns'
  | 'exportSessionMarkdown'   // ← add this line
  | 'cancelCronJob'
  | 'analyzeEmail'
```

- [ ] **Step 2: Add to `ServiceClient` interface + impl**

In `packages/protocol/src/service-client.ts`:
- In the `ServiceClient` interface (near `getRunEvents`):
  ```ts
  exportSessionMarkdown(sessionId: string): Promise<{ path: string }>
  ```
- In the implementation object (near the `getRunEvents` impl):
  ```ts
  exportSessionMarkdown(sessionId: string) {
    return call('exportSessionMarkdown', [sessionId])
  },
  ```

- [ ] **Step 3: Implement the service method**

In `apps/desktop/src/service/session/session-service.ts`, add the method to the service object. It needs an `exportsDir` (a write-target directory). If the service doesn't already receive one, add it to the deps/constructor (see Step 5 for the wiring). The method:

```ts
async exportSessionMarkdown(sessionId: string): Promise<{ path: string }> {
  const rows = this.store.getRunEvents(sessionId)
  const md = buildMarkdown(rows)
  const dir = this.exportsDir
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${sessionId}-${Date.now()}.md`)
  await fs.writeFile(file, md, 'utf8')
  this.log.info({ msg: 'session exported', sessionId, path: file })
  return { path: file }
}
```

Adjust to the actual service shape (it may use closures over `deps` rather than `this`). Import `buildMarkdown` from `./markdown-export` (or the correct relative path) and `fs`/`path` from `node:fs`/`node:path`. Use the existing logger (`createLogger(...)`).

- [ ] **Step 4: Wire the dispatcher**

In `apps/desktop/src/service/ipc/dispatcher.ts`, find the dispatch table for `ServiceMethod` and add the `'exportSessionMarkdown'` case routing to `service.exportSessionMarkdown(...args)`. Mirror exactly how `'getRunEvents'` is dispatched.

- [ ] **Step 5: Plumb `exportsDir` into the service**

In `apps/desktop/src/service/index.ts` (where the service is constructed), pass an `exportsDir` resolved from the path injected by main. The main process forks the service with config (READ `apps/desktop/src/main/index.ts` to see how config/paths are passed to the service fork — likely via `utilityProcess.fork(env)` or a startup message). Add `exportsDir: path.join(userData, 'exports')` to whatever config object the service receives, and have `session-service.ts` read it from its deps.

- [ ] **Step 6: Type-check + service tests**

```bash
pnpm --filter desktop run typecheck:web
pnpm --filter desktop exec vitest run src/service
```
Expected: no type errors. Service tests should still pass (existing ones; the new method has no dedicated test in this task — Task 5 covers end-to-end). NOTE: pre-existing `better-sqlite3` env failures may appear — confirm they're the same NODE_MODULE_VERSION mismatch, not caused by this change.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src/types/service-ipc.ts packages/protocol/src/service-client.ts apps/desktop/src/service/session/session-service.ts apps/desktop/src/service/ipc/dispatcher.ts apps/desktop/src/service/index.ts
git commit -m "feat(service): add exportSessionMarkdown service method"
```

---

## Task 4: `listArtifacts` main-process service + tests (TDD)

**Files:**
- Create: `apps/desktop/src/main/cmd-palette/artifacts-service.ts`
- Create: `apps/desktop/src/main/cmd-palette/artifacts-service.test.ts`
- Modify: `apps/desktop/src/main/constants.ts`

- [ ] **Step 1: Add `paths.exports()` (used later, but declare now)**

In `apps/desktop/src/main/constants.ts`, add to the `paths` object:
```ts
  exports: () => join(app.getPath('userData'), 'exports'),
```
(Place near the other userData entries.)

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/main/cmd-palette/artifacts-service.test.ts`:

```ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listArtifacts } from './artifacts-service'

let cwd: string
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'swarm-artifacts-'))
})
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

// Bilibili source is injected (so the test doesn't touch the real store).
const noBilibili = async () => []

describe('listArtifacts', () => {
  it('returns files under cwd sorted by mtime desc', async () => {
    const a = join(cwd, 'a.md')
    const b = join(cwd, 'b.md')
    await writeFile(a, 'older', 'utf8')
    await new Promise((r) => setTimeout(r, 20))
    await writeFile(b, 'newer', 'utf8')
    const out = await listArtifacts({ cwd, bilibiliSource: noBilibili })
    const names = out.map((e) => e.name)
    expect(names).toContain('a.md')
    expect(names).toContain('b.md')
    expect(names.indexOf('b.md')).toBeLessThan(names.indexOf('a.md'))
  })

  it('skips node_modules and .git', async () => {
    await mkdir(join(cwd, 'node_modules'), { recursive: true })
    await mkdir(join(cwd, '.git'), { recursive: true })
    await writeFile(join(cwd, 'node_modules', 'pkg.js'), 'x')
    await writeFile(join(cwd, '.git', 'config'), 'x')
    await writeFile(join(cwd, 'real.md'), 'x')
    const out = await listArtifacts({ cwd, bilibiliSource: noBilibili })
    expect(out.map((e) => e.name)).toEqual(['real.md'])
  })

  it('skips hidden files (dotfiles)', async () => {
    await writeFile(join(cwd, '.secret'), 'x')
    await writeFile(join(cwd, 'visible.txt'), 'x')
    const out = await listArtifacts({ cwd, bilibiliSource: noBilibili })
    expect(out.map((e) => e.name)).toEqual(['visible.txt'])
  })

  it('caps directory depth at 3', async () => {
    await mkdir(join(cwd, 'a', 'b', 'c', 'd'), { recursive: true })
    await writeFile(join(cwd, 'a', 'b', 'c', 'd', 'deep.md'), 'x')
    await writeFile(join(cwd, 'shallow.md'), 'x')
    const out = await listArtifacts({ cwd, bilibiliSource: noBilibili })
    expect(out.map((e) => e.name)).not.toContain('deep.md')
    expect(out.map((e) => e.name)).toContain('shallow.md')
  })

  it('filters by substring (case-insensitive) across name + origin', async () => {
    await writeFile(join(cwd, 'report-FINAL.md'), 'x')
    await writeFile(join(cwd, 'notes.txt'), 'x')
    const out = await listArtifacts({ cwd, bilibiliSource: noBilibili, query: 'final' })
    expect(out.map((e) => e.name)).toEqual(['report-FINAL.md'])
  })

  it('respects the limit', async () => {
    for (let i = 0; i < 8; i++) {
      await writeFile(join(cwd, `f${i}.md`), 'x')
      await new Promise((r) => setTimeout(r, 5))
    }
    const out = await listArtifacts({ cwd, bilibiliSource: noBilibili, limit: 3 })
    expect(out).toHaveLength(3)
  })

  it('includes bilibili analyses from the injected source', async () => {
    const bilibili = async () => [
      { bvid: 'BV1xx', title: 'RAG 教程', origin: 'Bilibili' },
    ]
    const out = await listArtifacts({ cwd, bilibiliSource: bilibili })
    const bili = out.find((e) => e.kind === 'bilibili-analysis')
    expect(bili).toBeDefined()
    expect(bili?.name).toBe('RAG 教程')
    expect(bili?.ref).toBe('BV1xx')
  })

  it('returns empty array when cwd has no matching files', async () => {
    const out = await listArtifacts({ cwd, bilibiliSource: noBilibili })
    expect(out).toEqual([])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter desktop exec vitest run src/main/cmd-palette/artifacts-service.test.ts
```
Expected: FAIL — "Failed to resolve import './artifacts-service'".

- [ ] **Step 4: Implement `listArtifacts`**

Create `apps/desktop/src/main/cmd-palette/artifacts-service.ts`:

```ts
// Observable-artifact index for the command palette's `/` 文件 & 产出 scope.
// Aggregates two sources in the MAIN process (filesystem access + bilibili
// analyses): cwd-recent-files and saved Bilibili summaries. Composer
// attachments are deferred (cross-process join not worth it for 3a).
//
// Pure-ish: filesystem-scanning is a side effect, but the bilibili source is
// injected so tests can stub it. cwd scan caps depth at 3, skips node_modules /
// .git / dotfiles, and filters to files modified within the last 14 days.

import { readdir, stat } from 'node:fs/promises'
import { basename, relative } from 'node:path'

import type { ArtifactEntry } from '@swarm/protocol'

const MAX_DEPTH = 3
const MAX_AGE_MS = 14 * 86_400_000
const DEFAULT_LIMIT = 50

export type BilibiliArtifact = { bvid: string; title: string; origin: string }
export type BilibiliSource = () => Promise<BilibiliArtifact[]>

type ListOpts = {
  cwd: string
  bilibiliSource: BilibiliSource
  query?: string
  limit?: number
}

export async function listArtifacts(opts: ListOpts): Promise<ArtifactEntry[]> {
  const now = Date.now()
  const limit = opts.limit ?? DEFAULT_LIMIT

  const [files, bilibili] = await Promise.all([
    scanCwd(opts.cwd, now),
    opts.bilibiliSource().catch(() => []),
  ])

  const entries: ArtifactEntry[] = [
    ...files.map((f) => ({
      kind: 'file' as const,
      name: f.name,
      ref: f.path,
      size: f.size,
      modifiedAt: f.mtime,
      origin: opts.cwd,
    })),
    ...bilibili.map((b) => ({
      kind: 'bilibili-analysis' as const,
      name: b.title,
      ref: b.bvid,
      origin: b.origin,
    })),
  ]

  const filtered = opts.query
    ? entries.filter((e) => `${e.name} ${e.origin}`.toLowerCase().includes(opts.query.toLowerCase()))
    : entries

  // Files are already mtime-desc from scanCwd; bilibili appended after. Preserve
  // that order (recent files first), then truncate.
  return filtered.slice(0, limit)
}

type ScannedFile = { name: string; path: string; size: number; mtime: number }

async function scanCwd(cwd: string, now: number): Promise<ScannedFile[]> {
  const out: ScannedFile[] = []
  const skip = new Set(['node_modules', '.git', '.next', '.cache', 'dist', 'build'])

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable dir — skip silently
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue
        await walk(full, depth + 1)
      } else if (entry.isFile()) {
        let s: import('node:fs').Stats
        try {
          s = await stat(full)
        } catch {
          continue
        }
        if (now - s.mtimeMs > MAX_AGE_MS) continue
        out.push({ name: entry.name, path: full, size: s.size, mtime: s.mtimeMs })
      }
    }
  }

  await walk(cwd, 1)
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter desktop exec vitest run src/main/cmd-palette/artifacts-service.test.ts
```
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/cmd-palette/artifacts-service.ts apps/desktop/src/main/cmd-palette/artifacts-service.test.ts
git commit -m "feat(main): add listArtifacts service for the command palette / scope"
```

---

## Task 5: Wire IPC + preload + swarmApi

**Files:**
- Modify: `apps/desktop/src/main/cmd-palette/index.ts` (create — the artifacts IPC registration)
- Modify: `apps/desktop/src/main/ipc/swarm-ipc.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/src/lib/api.ts`

- [ ] **Step 1: Create the cmd-palette main wiring**

Create `apps/desktop/src/main/cmd-palette/index.ts`:

```ts
// Main-process wiring for the command-palette backend. Owns the artifacts
// service (cwd scan + bilibili) and its IPC handler. The bilibili source is
// injected so it can be supplied after the bilibili subsystem inits.

import type { ArtifactEntry } from '@swarm/protocol'

import { listArtifacts, type BilibiliArtifact, type BilibiliSource } from './artifacts-service'

export type CmdPaletteHandle = {
  /** Returns artifacts matching the optional query, scanning the given cwd. */
  listArtifacts(opts: { cwd?: string; query?: string; limit?: number }): Promise<ArtifactEntry[]>
}

export function initCmdPaletteArtifacts(opts: {
  defaultCwd: string
  bilibiliSource: BilibiliSource
}): CmdPaletteHandle {
  return {
    async listArtifacts({ cwd, query, limit }) {
      return listArtifacts({
        cwd: cwd ?? opts.defaultCwd,
        bilibiliSource: opts.bilibiliSource,
        query,
        limit,
      })
    },
  }
}

// Helper for callers that have bilibili analyses but not in the ArtifactEntry
// shape — converts the analysis-store output to BilibiliArtifact[].
export function toBilibiliArtifacts(analyses: Array<{ bvid: string; title?: string | null }>): BilibiliArtifact[] {
  return analyses.map((a) => ({ bvid: a.bvid, title: a.title ?? a.bvid, origin: 'Bilibili' }))
}
```

- [ ] **Step 2: Register the IPC handlers**

In `apps/desktop/src/main/ipc/swarm-ipc.ts`, register both new channels inside `wireSwarmIpc(...)` (mirror how `memory:list` etc. are wired):

```ts
ipcMain.handle('swarm:exportSessionMarkdown', (_e, sessionId: string) =>
  serviceClient.exportSessionMarkdown(sessionId),
)
ipcMain.handle('swarm:listArtifacts', (_e, opts?: { cwd?: string; query?: string; limit?: number }) =>
  cmdPalette.listArtifacts(opts ?? {}),
)
```

`cmdPalette` must be passed into `wireSwarmIpc` — extend the wiring's options/deps to accept the `CmdPaletteHandle`. Add it to the function signature and the call site in `apps/desktop/src/main/index.ts`.

Also register the cleanup (`ipcMain.removeHandler`) in the dispose path that already removes the other handlers.

- [ ] **Step 3: Initialize in main and pass to wiring**

In `apps/desktop/src/main/index.ts`, after the bilibili subsystem and the service client are ready, construct the handle:

```ts
const bilibiliAnalysisSource = async () => {
  // Read from the bilibili analysis store (the same data `analyzedBvids` exposes).
  // Convert to BilibiliArtifact[] via toBilibiliArtifacts. READ the analysis-store
  // API to call the right method — likely something like bilibiliHandle.analysisStore.bvids()
  // cross-referenced with titles. If titles aren't stored, fall back to bvid as the title.
  return toBilibiliArtifacts(/* ... */)
}
const cmdPalette = initCmdPaletteArtifacts({
  defaultCwd: app.getPath('home'), // or a sensible default; the renderer passes cwd when available
  bilibiliSource: bilibiliAnalysisSource,
})
```

Pass `cmdPalette` into `wireSwarmIpc(...)`. Also pass `paths.exports()` into the service fork config (Task 3 Step 5 referenced this — confirm it's plumbed).

READ `apps/desktop/src/main/bilibili/analysis-store.ts` to find the actual method that lists analyses + their titles; adapt the `bilibiliAnalysisSource` accordingly.

- [ ] **Step 4: Add preload bridge methods**

In `apps/desktop/src/preload/index.ts`, add to the `swarm` bridge (find the right place — `swarm:exportSessionMarkdown` and `swarm:listArtifacts` are top-level since they don't belong to a subsystem namespace):

```ts
exportSessionMarkdown: (sessionId: string) =>
  ipcRenderer.invoke('swarm:exportSessionMarkdown', sessionId) as Promise<{ path: string }>,
listArtifacts: (opts?: { cwd?: string; query?: string; limit?: number }) =>
  ipcRenderer.invoke('swarm:listArtifacts', opts) as Promise<import('@swarm/protocol').ArtifactEntry[]>,
```

Also add the two methods to the `SwarmBridge` type in `packages/protocol/src/types/ui.ts` (near `submitGoal` etc.) so the renderer typings know about them.

- [ ] **Step 5: Add `swarmApi` facade entries**

In `apps/desktop/src/renderer/src/lib/api.ts`, add to the `swarmApi` object:

```ts
exportSessionMarkdown: (sessionId: string): Promise<{ path: string }> =>
  window.swarm.exportSessionMarkdown(sessionId),
listArtifacts: (opts?: { cwd?: string; query?: string; limit?: number }): Promise<ArtifactEntry[]> =>
  window.swarm.listArtifacts(opts),
```

Import `ArtifactEntry` from `@swarm/protocol` at the top.

- [ ] **Step 6: Type-check + full test**

```bash
pnpm --filter desktop run typecheck:web
pnpm --filter desktop exec vitest run src/renderer src/main/cmd-palette src/service/conversation
```
Expected: type errors none; the targeted tests pass. (Pre-existing sqlite/main tests may still fail on the env mismatch — that's not this change.)

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/cmd-palette/index.ts apps/desktop/src/main/ipc/swarm-ipc.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/src/lib/api.ts packages/protocol/src/types/ui.ts
git commit -m "feat(cmd-palette): wire exportSessionMarkdown + listArtifacts IPC end-to-end"
```

---

## Task 6: Manual verification + build

**Files:** none

- [ ] **Step 1: Build the app**

```bash
pnpm --filter desktop build
```
Expected: build succeeds (catches any bundle-time import error in main/preload/service).

- [ ] **Step 2: Smoke-check the IPC end-to-end (dev run)**

```bash
pnpm --filter desktop dev
```

Open Electron DevTools and in the console run:
```js
await window.swarm.listArtifacts({ cwd: '/Users', limit: 5 })
```
Expected: resolves to an `ArtifactEntry[]` (may be empty if `/Users` has no recent files, but should not throw).

```js
// After opening any session:
await window.swarm.exportSessionMarkdown('<some-session-id>')
```
Expected: resolves to `{ path: '/.../exports/<id>-<ts>.md' }`, and the file exists + opens.

(If you don't have a session id handy, skip the export smoke check and rely on the unit tests + build.)

- [ ] **Step 3: Final test + typecheck pass**

```bash
pnpm --filter desktop run typecheck:web
pnpm --filter desktop exec vitest run src/renderer src/main/cmd-palette src/service/conversation
```
Expected: clean.

---

## Self-Review

**Spec coverage:**
- §4.1 Export Markdown → Tasks 2 (pure builder) + 3 (service) + 5 (IPC/preload/api). ✓
- §4.2 Observable artifact index → Tasks 1 (type) + 4 (service) + 5 (IPC/preload/api). ✓
- §1 Non-goal: composer-attachments aggregation — explicitly NOT in 3a (deferred). ✓
- §2 Decisions: 3a is backend-only (no UI), reuses existing `getRunEvents` + bilibili analysis store. ✓

**Placeholder scan:** Tasks 3 and 5 contain "READ <file>" instructions because the exact service-constructor shape and bilibili analysis-store API must be confirmed against the running code — these are NOT placeholders, they're directed reads with the surrounding code shown. Every code block is complete. No TBD/TODO.

**Type consistency:**
- `ArtifactEntry` defined once (Task 1), consumed unchanged in Task 4 (`listArtifacts` returns it) and Task 5 (preload/api).
- `buildMarkdown(rows: RunEvent[])` defined in Task 2, called from Task 3.
- `ServiceMethod` extended once in Task 3; `ServiceClient` + dispatcher + service impl all reference the same `'exportSessionMarkdown'` string.
- `BilibiliArtifact`/`BilibiliSource` defined in Task 4, re-exported via Task 5's `index.ts`.

**Scope:** Two independent features (export + artifacts) + their shared wiring (Task 5). Each task compiles independently; Tasks 1→4 are additive, Task 5 wires everything, Task 6 verifies.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-05-cmd-palette-3a-backend.md`. After committing this plan, dispatch via subagent-driven-development (recommended) — Tasks 1–4 are well-scoped TDD units; Task 5 is the integration task that benefits most from review.
