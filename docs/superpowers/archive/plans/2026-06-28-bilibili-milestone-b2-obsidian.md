# Bilibili Milestone B2 — AI 总结写入 Obsidian Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在视频详情面板把已生成的 AI 总结按模板渲染成 Markdown 笔记，点击「保存到 Obsidian」写入用户在设置中配置的 Obsidian 库。

**Architecture:** 复用 milestone B 的 `src/main/bilibili/` 分层与 `BiliSummary`。新增纯逻辑 `obsidian.ts`（渲染模板 + 文件名 + 写盘），在 `ipc.ts` 加 4 个端点（读/写配置、选目录、保存），扩展加密 store 的配置 schema，渲染层新增一个 Settings 区与面板内的保存按钮。

**Tech Stack:** Electron main (`node:fs/promises`, `dialog.showOpenDialog`), Zod, TanStack Query, base-ui 组件。

## Global Constraints

- 语言：对话中文；**代码注释与 commit message 一律英文**（CLAUDE.md §0）。
- 日志（CLAUDE.md §5）：`createLogger({ process: 'main' }).child({ component: 'bilibili-obsidian' })`（obsidian.ts）；写盘入口/出口 `info` 带 `bvid` + `path`，`catch` `error` 不吞，未配置库 `warn`。
- 简单优先 / 外科手术式改动（CLAUDE.md §2/§3）。
- 测试用 `npm test -- --run <path>`（Electron node）；**绝不** `pnpm rebuild better-sqlite3`。
- biome 用 scoped：`node_modules/.bin/biome check --write <files>`（不要 repo-wide `pnpm check`）。
- typecheck：`npm run typecheck:node` / `:web` 干净，**忽略**预存的 `TS6307`（`tsconfig.web.json` / "not listed within the file list" / "Imported via"）噪音。
- Obsidian 配置**不是机密**，但仍存进现有加密的 `BilibiliConfigOnDisk`（复用 store，最省）。
- 同名笔记**覆盖**（最新总结为准）。文件名不做可配置模板（YAGNI）。
- Worktree：进入后若无 `node_modules` 先 `ln -s <main-repo>/node_modules <worktree>/node_modules`。
- 渲染层设置页与面板**通过 `swarmApi` 包装函数**调用（不直接用 `window.swarm`），以便测试 mock `swarmApi`（与现有 bilibili 测试一致）。

---

### Task 1: 配置 schema + 桥接签名/实现（保持树绿）

**Files:**
- Modify: `src/shared/types/bilibili.ts`
- Modify: `src/shared/types/ui.ts` (`BilibiliBridge`)
- Modify: `src/preload/index.ts` (bilibili bridge object)
- Modify: `src/renderer/src/lib/api.ts` (swarmApi wrappers)

**Interfaces:**
- Produces:
  - `ObsidianConfig = { vaultPath: string; subdir: string }`
  - `BiliSaveResult = { ok: true; path: string } | { ok: false; code: 'no_vault' | 'write_failed'; message: string }`
  - `BilibiliBridge.getObsidianConfig(): Promise<ObsidianConfig | null>`
  - `BilibiliBridge.setObsidianConfig(cfg: ObsidianConfig): Promise<void>`
  - `BilibiliBridge.pickVault(): Promise<string | null>`
  - `BilibiliBridge.save(video: BiliVideo, summary: BiliSummary): Promise<BiliSaveResult>`
  - swarmApi: `bilibiliGetObsidianConfig`, `bilibiliSetObsidianConfig`, `bilibiliPickVault`, `bilibiliSave`

- [ ] **Step 1: Extend `src/shared/types/bilibili.ts`**

Add the schema + types (after `BiliCredentialsSchema`), extend the on-disk config, and update the default:

```typescript
export const ObsidianConfigSchema = z
  .object({
    vaultPath: z.string(),
    subdir: z.string(),
  })
  .strict()

export type ObsidianConfig = z.infer<typeof ObsidianConfigSchema>

export type BiliSaveResult =
  | { ok: true; path: string }
  | { ok: false; code: 'no_vault' | 'write_failed'; message: string }
```

Change `BilibiliConfigOnDisk` to include `obsidian` (defaulting to `null` so existing encrypted configs without the field still parse):

```typescript
export const BilibiliConfigOnDisk = z
  .object({
    credentials: BiliCredentialsSchema.nullable(),
    obsidian: ObsidianConfigSchema.nullable().default(null),
  })
  .strict()
```

And update the default factory:

```typescript
export function defaultBilibiliConfigOnDisk(): BilibiliConfigOnDisk {
  return { credentials: null, obsidian: null }
}
```

- [ ] **Step 2: Extend `BilibiliBridge` in `src/shared/types/ui.ts`**

Add to the `BilibiliBridge` type (after `open`), and add `BiliSaveResult`, `ObsidianConfig`, `BiliVideo`, `BiliSummary` to the existing `@shared/types/bilibili` import in that file as needed:

```typescript
  getObsidianConfig: () => Promise<ObsidianConfig | null>
  setObsidianConfig: (cfg: ObsidianConfig) => Promise<void>
  pickVault: () => Promise<string | null>
  save: (video: BiliVideo, summary: BiliSummary) => Promise<BiliSaveResult>
```

- [ ] **Step 3: Implement preload methods in `src/preload/index.ts`**

In the `bilibili` bridge object (after `open`), add (importing the new types where the file imports bilibili types):

```typescript
  getObsidianConfig: () => ipcRenderer.invoke('bilibili:getObsidianConfig') as Promise<ObsidianConfig | null>,
  setObsidianConfig: (cfg: ObsidianConfig) => ipcRenderer.invoke('bilibili:setObsidianConfig', cfg) as Promise<void>,
  pickVault: () => ipcRenderer.invoke('bilibili:pickVault') as Promise<string | null>,
  save: (video: BiliVideo, summary: BiliSummary) =>
    ipcRenderer.invoke('bilibili:save', video, summary) as Promise<BiliSaveResult>,
```

- [ ] **Step 4: Add swarmApi wrappers in `src/renderer/src/lib/api.ts`**

After `bilibiliOpen` (import the new types at the top of the file):

```typescript
  bilibiliGetObsidianConfig: (): Promise<ObsidianConfig | null> => window.swarm.bilibili.getObsidianConfig(),
  bilibiliSetObsidianConfig: (cfg: ObsidianConfig): Promise<void> => window.swarm.bilibili.setObsidianConfig(cfg),
  bilibiliPickVault: (): Promise<string | null> => window.swarm.bilibili.pickVault(),
  bilibiliSave: (video: BiliVideo, summary: BiliSummary): Promise<BiliSaveResult> =>
    window.swarm.bilibili.save(video, summary),
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:node` then `npm run typecheck:web`
Expected: no NEW errors in bilibili.ts / ui.ts / preload/index.ts / api.ts (TS6307 noise ignored). The IPC handlers don't exist yet — that's fine, `invoke` resolves at runtime once Task 3 lands.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/bilibili.ts src/shared/types/ui.ts src/preload/index.ts src/renderer/src/lib/api.ts
git commit -m "feat(bilibili): obsidian config schema and save/config bridge types"
```

---

### Task 2: `obsidian.ts` — 渲染笔记 + 文件名 + 写盘

**Files:**
- Create: `src/main/bilibili/obsidian.ts`
- Test: `src/main/bilibili/obsidian.test.ts`

**Interfaces:**
- Consumes: `ObsidianConfig`, `BiliSaveResult`, `BiliVideo`, `BiliSummary` (Task 1).
- Produces:
  - `noteFilename(title: string, bvid: string): string`
  - `renderNote(video: BiliVideo, summary: BiliSummary, processed: string): string`
  - `writeNote(cfg: ObsidianConfig | null, video: BiliVideo, summary: BiliSummary, processed: string): Promise<BiliSaveResult>`

- [ ] **Step 1: Write the failing test** `src/main/bilibili/obsidian.test.ts`

```typescript
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BiliSummary, BiliVideo } from '@shared/types/bilibili'
import { describe, expect, it } from 'vitest'
import { noteFilename, renderNote, writeNote } from './obsidian'

const video: BiliVideo = {
  bvid: 'BV1x',
  title: 'How to: build/things',
  cover: '',
  author: 'up主',
  durationSec: 65,
  intro: '',
  source: 'CS',
}
const summary: BiliSummary = {
  gist: '主旨一句话',
  points: ['要点A', '要点B'],
  experience: [],
  pitfalls: ['坑1'],
  steps: ['第一步', '第二步'],
}

describe('noteFilename', () => {
  it('strips path-unsafe characters and appends the bvid', () => {
    expect(noteFilename('How to: build/things', 'BV1x')).toBe('How to  build things-BV1x.md')
  })
  it('falls back to the bvid when the title sanitizes to empty', () => {
    expect(noteFilename('///', 'BV9')).toBe('BV9-BV9.md')
  })
})

describe('renderNote', () => {
  it('renders quoted frontmatter, skips empty sections, numbers steps', () => {
    const md = renderNote(video, summary, '2026-06-28')
    expect(md).toContain('title: "How to: build/things"')
    expect(md).toContain('bvid: BV1x')
    expect(md).toContain('url: https://www.bilibili.com/video/BV1x')
    expect(md).toContain('duration: 1:05')
    expect(md).toContain('processed: 2026-06-28')
    expect(md).toContain('## 核心要点\n\n- 要点A\n- 要点B')
    expect(md).toContain('## 踩坑 / 注意\n\n- 坑1')
    expect(md).toContain('## 可执行步骤\n\n1. 第一步\n2. 第二步')
    // experience is empty -> its heading must not appear
    expect(md).not.toContain('## 可复用经验')
  })
})

describe('writeNote', () => {
  it('returns no_vault when config is null', async () => {
    const r = await writeNote(null, video, summary, '2026-06-28')
    expect(r).toEqual({ ok: false, code: 'no_vault', message: expect.any(String) })
  })
  it('writes the note under vaultPath/subdir and returns the path', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'obs-'))
    const r = await writeNote({ vaultPath: vault, subdir: 'bili' }, video, summary, '2026-06-28')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.path).toBe(join(vault, 'bili', 'How to  build things-BV1x.md'))
      const written = await readFile(r.path, 'utf8')
      expect(written).toContain('主旨一句话')
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/main/bilibili/obsidian.test.ts`
Expected: FAIL — `Cannot find module './obsidian'`.

- [ ] **Step 3: Implement `src/main/bilibili/obsidian.ts`**

```typescript
// Renders an AI summary into an Obsidian "experience note" markdown file and
// writes it into the configured vault. Pure render/filename helpers are split
// from the fs write so they can be unit-tested without disk. Same-named notes
// are overwritten (latest summary wins).
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '@shared/logger'
import type { BiliSaveResult, BiliSummary, BiliVideo, ObsidianConfig } from '@shared/types/bilibili'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-obsidian' })

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Replace characters illegal in file names (and path separators) with a space,
// collapse runs, trim, cap length; fall back to the bvid if nothing remains.
export function noteFilename(title: string, bvid: string): string {
  const safe = title
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `${safe || bvid}-${bvid}.md`
}

export function renderNote(video: BiliVideo, summary: BiliSummary, processed: string): string {
  const q = (s: string): string => `"${s.replace(/"/g, '\\"')}"`
  const url = `https://www.bilibili.com/video/${video.bvid}`
  const lines: string[] = [
    '---',
    `title: ${q(video.title)}`,
    `bvid: ${video.bvid}`,
    `url: ${url}`,
    `author: ${q(video.author)}`,
    `duration: ${fmtDuration(video.durationSec)}`,
    `source: ${q(video.source)}`,
    `processed: ${processed}`,
    'tags: [bilibili]',
    '---',
    '',
    '## 一句话主旨',
    '',
    summary.gist,
  ]
  const bulleted = (heading: string, items: string[]): void => {
    if (items.length === 0) return
    lines.push('', `## ${heading}`, '')
    for (const it of items) lines.push(`- ${it}`)
  }
  bulleted('核心要点', summary.points)
  bulleted('可复用经验 / 方法论', summary.experience)
  bulleted('踩坑 / 注意', summary.pitfalls)
  if (summary.steps.length > 0) {
    lines.push('', '## 可执行步骤', '')
    summary.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
  }
  lines.push('', '## 原视频', '', `[${video.title}](${url})`)
  return `${lines.join('\n')}\n`
}

export async function writeNote(
  cfg: ObsidianConfig | null,
  video: BiliVideo,
  summary: BiliSummary,
  processed: string
): Promise<BiliSaveResult> {
  if (!cfg || !cfg.vaultPath) {
    log.warn({ msg: 'save requested but no vault configured', bvid: video.bvid })
    return { ok: false, code: 'no_vault', message: '未配置 Obsidian 库路径，请在设置中配置。' }
  }
  const dir = cfg.subdir ? join(cfg.vaultPath, cfg.subdir) : cfg.vaultPath
  const path = join(dir, noteFilename(video.title, video.bvid))
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, renderNote(video, summary, processed), 'utf8')
    log.info({ msg: 'note written', bvid: video.bvid, path })
    return { ok: true, path }
  } catch (err) {
    log.error({ msg: 'note write failed', bvid: video.bvid, err: err instanceof Error ? err.message : String(err) })
    return { ok: false, code: 'write_failed', message: `写入失败：${err instanceof Error ? err.message : String(err)}` }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --run src/main/bilibili/obsidian.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/bilibili/obsidian.ts src/main/bilibili/obsidian.test.ts
git commit -m "feat(bilibili): render and write AI summary as an Obsidian note"
```

---

### Task 3: IPC 端点（读/写配置、选目录、保存）

**Files:**
- Modify: `src/main/bilibili/ipc.ts`
- Modify: `src/main/bilibili/ipc.test.ts`

**Interfaces:**
- Consumes: `writeNote` (Task 2); `store` (already passed to `wireBilibiliIpc`); Electron `dialog`.
- Produces: IPC channels `bilibili:getObsidianConfig`, `bilibili:setObsidianConfig`, `bilibili:pickVault`, `bilibili:save`.

- [ ] **Step 1: Write the failing test** — add to `src/main/bilibili/ipc.test.ts`

Note: the existing test file mocks `electron` with only `ipcMain`. Extend that mock factory to also export a `dialog` stub so `ipc.ts`'s new `import { dialog }` resolves:

```typescript
// in the existing vi.mock('electron', ...) factory return object, add alongside ipcMain:
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }) },
    shell: { openExternal: async () => undefined },
```

Then add the test (the existing `fakeStore.load` returns `{ credentials: creds }` with no `obsidian`, so save must report `no_vault`):

```typescript
it('save returns no_vault when no obsidian vault is configured', async () => {
  const fakeAuth: Auth = {
    status: vi.fn(async () => ({ loggedIn: true, uname: 'user', mid: 42 })),
    login: vi.fn(async () => ({ loggedIn: true, uname: 'user', mid: 42 })),
    logout: vi.fn(async () => undefined),
  }
  const fakeStore: Store = {
    load: vi.fn(async () => ({ credentials: creds })),
    save: vi.fn(async () => undefined),
  }
  wireBilibiliIpc({ auth: fakeAuth, store: fakeStore, getInjection: () => null })
  const video = vid('BV1', 'CS')
  const summary = { gist: 'g', points: [], experience: [], pitfalls: [], steps: [] }
  const result = await invokeHandler('bilibili:save', video, summary)
  expect(result).toMatchObject({ ok: false, code: 'no_vault' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/main/bilibili/ipc.test.ts`
Expected: FAIL — `No handler registered for 'bilibili:save'`.

- [ ] **Step 3: Wire the handlers in `src/main/bilibili/ipc.ts`**

Add `dialog` to the electron import (`import { dialog, ipcMain, shell } from 'electron'`), import `writeNote` and the types, then register (after the `bilibili:open` handler):

```typescript
  ipcMain.handle('bilibili:getObsidianConfig', async (): Promise<ObsidianConfig | null> => {
    return (await store.load()).obsidian ?? null
  })
  ipcMain.handle('bilibili:setObsidianConfig', async (_e, cfg: ObsidianConfig): Promise<void> => {
    const current = await store.load()
    await store.save({ ...current, obsidian: cfg })
    log.info({ msg: 'obsidian config saved', vaultPath: cfg.vaultPath, subdir: cfg.subdir })
  })
  ipcMain.handle('bilibili:pickVault', async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })
  ipcMain.handle('bilibili:save', async (_e, video: BiliVideo, summary: BiliSummary): Promise<BiliSaveResult> => {
    const cfg = (await store.load()).obsidian ?? null
    return writeNote(cfg, video, summary, new Date().toISOString().slice(0, 10))
  })
```

Imports to add: `import { writeNote } from './obsidian'` and add `BiliSaveResult`, `BiliSummary`, `ObsidianConfig` to the `@shared/types/bilibili` type import. Add the 4 new channels to the `dispose()` removeHandler list.

- [ ] **Step 4: Run tests**

Run: `npm test -- --run src/main/bilibili/ipc.test.ts`
Expected: PASS (all, including the new save test).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck:node`

```bash
git add src/main/bilibili/ipc.ts src/main/bilibili/ipc.test.ts
git commit -m "feat(bilibili): IPC for obsidian config, vault picker, and save"
```

---

### Task 4: Settings 新增 "Bilibili" 区

**Files:**
- Create: `src/renderer/src/components/views/bilibili-settings-view.tsx`
- Test: `src/renderer/src/components/views/bilibili-settings-view.test.tsx`
- Modify: `src/renderer/src/stores/settings-dialog.ts` (add `'bilibili'` to `SettingsSection` + `SECTIONS`)
- Modify: `src/renderer/src/components/settings-dialog.tsx` (register the section)

**Interfaces:**
- Consumes: `swarmApi.bilibiliGetObsidianConfig` / `bilibiliSetObsidianConfig` / `bilibiliPickVault` (Task 1).
- Produces: `BilibiliSettingsView` component.

- [ ] **Step 1: Write the failing test** `bilibili-settings-view.test.tsx`

```typescript
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { swarmApi } from '@/lib/api'
import { BilibiliSettingsView } from './bilibili-settings-view'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('BilibiliSettingsView', () => {
  it('loads the existing vault path and saves a newly picked folder', async () => {
    vi.spyOn(swarmApi, 'bilibiliGetObsidianConfig').mockResolvedValue({ vaultPath: '/old/vault', subdir: 'bili' })
    vi.spyOn(swarmApi, 'bilibiliPickVault').mockResolvedValue('/new/vault')
    const set = vi.spyOn(swarmApi, 'bilibiliSetObsidianConfig').mockResolvedValue(undefined)
    render(<BilibiliSettingsView />)
    expect(await screen.findByDisplayValue('/old/vault')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /选择文件夹/ }))
    await waitFor(() => expect(set).toHaveBeenCalledWith({ vaultPath: '/new/vault', subdir: 'bili' }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/renderer/src/components/views/bilibili-settings-view.test.tsx`
Expected: FAIL — `Cannot find module './bilibili-settings-view'`.

- [ ] **Step 3: Implement `bilibili-settings-view.tsx`**

```tsx
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { swarmApi } from '@/lib/api'
import { Section, SettingsHeader } from './settings-primitives'

// Lets the user pick the Obsidian vault folder and a subdirectory the AI summary
// notes are written into. Reads/writes through swarmApi so the view is testable.
export function BilibiliSettingsView(): React.JSX.Element {
  const [vaultPath, setVaultPath] = useState('')
  const [subdir, setSubdir] = useState('')

  useEffect(() => {
    void swarmApi.bilibiliGetObsidianConfig().then((cfg) => {
      if (cfg) {
        setVaultPath(cfg.vaultPath)
        setSubdir(cfg.subdir)
      }
    })
  }, [])

  const pick = async (): Promise<void> => {
    const picked = await swarmApi.bilibiliPickVault()
    if (!picked) return
    setVaultPath(picked)
    await swarmApi.bilibiliSetObsidianConfig({ vaultPath: picked, subdir })
  }

  const saveSubdir = async (): Promise<void> => {
    if (!vaultPath) return
    await swarmApi.bilibiliSetObsidianConfig({ vaultPath, subdir })
  }

  return (
    <div className="space-y-5">
      <SettingsHeader description="AI 总结生成的笔记会写入这个 Obsidian 库。" title="Bilibili" />
      <Section title="Obsidian 库路径">
        <div className="flex items-center gap-2">
          <Input className="flex-1" placeholder="尚未选择" readOnly value={vaultPath} />
          <Button onClick={() => void pick()} variant="outline">
            选择文件夹
          </Button>
        </div>
      </Section>
      <Section title="子目录（可选）">
        <Input
          onBlur={() => void saveSubdir()}
          onChange={(e) => setSubdir(e.target.value)}
          placeholder="例如 bilibili"
          value={subdir}
        />
      </Section>
    </div>
  )
}
```

> Note: read `settings-primitives.tsx` first to confirm `Section`'s exact prop name (`title`) and `SettingsHeader`'s props; mirror what `web-search-view.tsx` passes. Adjust the prop names if they differ — keep the structure.

- [ ] **Step 4: Register the section**

In `src/renderer/src/stores/settings-dialog.ts`: add `'bilibili'` to the `SettingsSection` union and to the `SECTIONS` array (place it after `'agents'` or wherever reads naturally).

In `src/renderer/src/components/settings-dialog.tsx`: import the view + a lucide icon (use `Tv` from `lucide-react`), and add to `SECTIONS`:

```tsx
import { BilibiliSettingsView } from '@/components/views/bilibili-settings-view'
// add Tv to the existing lucide-react import
// in the SECTIONS array:
  { key: 'bilibili', label: 'Bilibili', icon: Tv, View: BilibiliSettingsView },
```

- [ ] **Step 5: Run tests + scoped lint + typecheck**

Run: `npm test -- --run src/renderer/src/components/views/bilibili-settings-view.test.tsx`
Run: `node_modules/.bin/biome check --write src/renderer/src/components/views/bilibili-settings-view.tsx src/renderer/src/components/views/bilibili-settings-view.test.tsx src/renderer/src/stores/settings-dialog.ts src/renderer/src/components/settings-dialog.tsx`
Run: `npm run typecheck:web`
Expected: tests PASS; typecheck clean (modulo TS6307).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/views/bilibili-settings-view.tsx src/renderer/src/components/views/bilibili-settings-view.test.tsx src/renderer/src/stores/settings-dialog.ts src/renderer/src/components/settings-dialog.tsx
git commit -m "feat(bilibili): Bilibili settings section for Obsidian vault config"
```

---

### Task 5: 详情面板「保存到 Obsidian」按钮

**Files:**
- Modify: `src/renderer/src/components/views/bilibili-view.tsx`
- Modify: `src/renderer/src/components/views/bilibili-view.test.tsx`

**Interfaces:**
- Consumes: `swarmApi.bilibiliSave` (Task 1); the existing `mutation.data.summary` (the AI summary already shown in the panel).

- [ ] **Step 1: Write the failing test** — add to `bilibili-view.test.tsx`

```typescript
it('saves the summary to Obsidian from the detail panel', async () => {
  vi.spyOn(swarmApi, 'getBilibiliStatus').mockResolvedValue({ loggedIn: true, uname: 'me', mid: 42 })
  vi.spyOn(swarmApi, 'getBilibiliList').mockResolvedValue(SAMPLE)
  vi.spyOn(swarmApi, 'bilibiliProcess').mockResolvedValue({
    ok: true,
    summary: { gist: 'AI主旨', points: ['要点一'], experience: [], pitfalls: [], steps: [] },
  })
  const save = vi.spyOn(swarmApi, 'bilibiliSave').mockResolvedValue({ ok: true, path: '/vault/bili/x.md' })
  render(wrap(<BilibiliView />))
  fireEvent.click(await screen.findByText('视频甲'))
  fireEvent.click(await screen.findByRole('button', { name: /AI 分析/ }))
  await screen.findByText('AI主旨')
  fireEvent.click(screen.getByRole('button', { name: /保存到 Obsidian/ }))
  await waitFor(() => expect(save).toHaveBeenCalled())
  expect(await screen.findByText(/已保存/)).toBeInTheDocument()
})
```

(Ensure `waitFor` is imported from `@testing-library/react` in this file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/renderer/src/components/views/bilibili-view.test.tsx`
Expected: FAIL — no `保存到 Obsidian` button.

- [ ] **Step 3: Implement** — inside `VideoDetailSheet`, add a second mutation and a save button shown only once a summary exists.

Add near the existing `mutation` (the analyze one):

```tsx
  const saveMutation = useMutation({
    mutationFn: (args: { video: BiliVideo; summary: BiliSummary }) => swarmApi.bilibiliSave(args.video, args.summary),
  })
```

Reset `saveMutation` alongside the existing `mutation.reset()` in the `video?.bvid` effect (so reopening another card clears the prior save status).

Render, right after the `SummaryView` (i.e. inside the `mutation.data?.ok` branch so it only shows when a summary exists):

```tsx
{mutation.data?.ok ? (
  <div className="flex flex-col gap-1">
    <Button
      className="w-fit"
      disabled={saveMutation.isPending}
      onClick={() => video && mutation.data?.ok && saveMutation.mutate({ video, summary: mutation.data.summary })}
      variant="outline"
    >
      {saveMutation.isPending ? '保存中…' : '保存到 Obsidian'}
    </Button>
    {saveMutation.data?.ok ? (
      <span className="text-muted-foreground text-xs">已保存到 {saveMutation.data.path}</span>
    ) : null}
    {saveMutation.data && !saveMutation.data.ok ? (
      <span className="text-destructive text-xs">{saveMutation.data.message}</span>
    ) : null}
  </div>
) : null}
```

(Keep the existing `<SummaryView>` render; this block sits next to it. `BiliSummary` is already imported in this file from milestone B.)

- [ ] **Step 4: Run tests + scoped lint + typecheck**

Run: `npm test -- --run src/renderer/src/components/views/bilibili-view.test.tsx`
Run: `node_modules/.bin/biome check --write src/renderer/src/components/views/bilibili-view.tsx src/renderer/src/components/views/bilibili-view.test.tsx`
Run: `npm run typecheck:web`
Expected: all tests PASS; typecheck clean (modulo TS6307).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/views/bilibili-view.tsx src/renderer/src/components/views/bilibili-view.test.tsx
git commit -m "feat(bilibili): save-to-Obsidian button in the video detail panel"
```

---

## Self-Review

- **Spec coverage (obsidian-design.md §6 笔记模板 / §7 设置项)**: §6 模板 ✔ (Task 2 renderNote — frontmatter + 5 段 + 原视频链接); §7 库路径 + 子目录 ✔ (Task 4); §7 文件名模板 → 收敛为固定 `{title}-{bvid}.md`（YAGNI，计划已声明）; §7 sherpa/ffmpeg 路径 → 属 milestone C，**不在本计划**。
- **写入触发**：设计决定为面板内「保存到 Obsidian」按钮（非自动），Task 5 实现。
- **Placeholder scan**: 无 TBD/TODO；每个改代码的步骤都给了完整代码。
- **Type consistency**: `BiliSaveResult` 的 code 枚举 `'no_vault' | 'write_failed'` 在 Task 1/2/3 一致；`writeNote(cfg, video, summary, processed)` 形参在 Task 2 定义、Task 3 调用一致（`processed` 由 ipc 用 `new Date().toISOString().slice(0,10)` 传入）；`ObsidianConfig = { vaultPath, subdir }` 全程一致。
- **绿树顺序**: Task 1 同时加类型 + preload/api 实现（invoke 先于 handler 存在不影响 typecheck）——与 milestone B Task 1 同样手法。
- **测试可测性**: 渲染层全部走 `swarmApi`（被测试 mock），不直接 `window.swarm`；`writeNote` 用临时目录实测写盘；`pickVault` 依赖系统 dialog 不单测（仅 save 的 no_vault 路径单测）。
