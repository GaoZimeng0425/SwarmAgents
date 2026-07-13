# Import Skill Folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users import a skill *folder* from disk (a `SKILL.md` plus optional `scripts/`/`references/` assets) instead of typing a single-file skill into an inline form.

**Architecture:** On import, the whole folder is copied into `userData/skills/<name>/` so existing `reload()`/`filePath` logic and the agent's `use_skill` relative-path resolution work unchanged. The inline create/edit form is removed; the per-skill view becomes read-only and lists the bundled file tree. New RPC `importSkill` threads service → main, with the native directory picker living in the main process.

**Tech Stack:** Electron (main `utilityProcess` + IPC), TypeScript, React + TanStack Router (renderer), Zod, Vitest, `better-sqlite3` (unrelated), Biome.

## Global Constraints

- Replies to the user are in Chinese; **all code comments and commit messages are in English** (CLAUDE.md §0).
- Every business path logs via the module's pino child logger: entry at `info`, outcome at `info`, every `catch` at `error`, branch surprises at `warn` (CLAUDE.md §5). The store logger already exists: `const log = createLogger({ process: 'service' }).child({ component: 'skills' })`.
- Skill name rule (verbatim from `SkillSchema`): `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 1–64 chars; description 1–1024 chars.
- Surgical changes only: keep backend `save()`/`remove()`; do not refactor unrelated code (CLAUDE.md §3).
- Run tests with `npm test` (Electron-as-node), never bare `npx vitest`; scope a single file with `npm test -- <path>`.
- Scoped formatting only: `npx biome check --write <file>` (never `pnpm check`, which reformats the whole repo).

---

### Task 1: Service store — `files` field + `importFolder()`

**Files:**
- Modify: `src/shared/types/skill.ts` (add `files?: string[]` to `SkillSchema`)
- Modify: `src/service/skills/store.ts` (recursive file listing in `reload()`, new `importFolder`)
- Test: `src/service/skills/store.test.ts`

**Interfaces:**
- Consumes: existing `parseSkill`, `SkillSchema`, `createSkillStore({ dir, builtins })`, `merged()`, `reload()`.
- Produces:
  - `Skill.files?: string[]` — relative POSIX paths of every file inside the skill folder (incl. `SKILL.md`), sorted; populated on load only.
  - `SkillStore.importFolder(sourceDir: string, overwrite?: boolean): SkillMutationResult` — copies a folder into the store. Failure codes: `'no_skill_md' | 'invalid' | 'exists' | 'write_failed'`.

- [ ] **Step 1: Add the `files` field to the schema**

In `src/shared/types/skill.ts`, inside `SkillSchema`, after the `filePath` field:

```ts
  // Absolute path to SKILL.md, populated on load (not part of the write input).
  filePath: z.string().optional(),
  // Relative POSIX paths of all files in the skill folder (incl. SKILL.md),
  // populated on load only. Lets the UI show what a folder-imported skill bundles.
  files: z.array(z.string()).optional(),
```

- [ ] **Step 2: Write the failing tests**

In `src/service/skills/store.test.ts`, extend the imports on line 1 to include `mkdirSync` and `writeFileSync`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
```

Add these tests inside the `describe('createSkillStore', ...)` block (after the last `it`):

```ts
  it('imports a folder with SKILL.md and bundled scripts', () => {
    const src = mkdtempSync(join(tmpdir(), 'swarm-import-'))
    mkdirSync(join(src, 'scripts'), { recursive: true })
    writeFileSync(join(src, 'SKILL.md'), '---\nname: deploy\ndescription: Deploy app\n---\n\nRun scripts/run.sh')
    writeFileSync(join(src, 'scripts', 'run.sh'), 'echo hi')
    const store = createSkillStore({ dir })
    const r = store.importFolder(src)
    expect(r.ok).toBe(true)
    expect(store.get('deploy')).toMatchObject({ description: 'Deploy app' })
    expect(store.get('deploy')?.files).toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(readFileSync(join(dir, 'deploy', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi')
    rmSync(src, { recursive: true, force: true })
  })

  it('rejects a folder with no SKILL.md', () => {
    const src = mkdtempSync(join(tmpdir(), 'swarm-import-'))
    const store = createSkillStore({ dir })
    const r = store.importFolder(src)
    expect(r).toMatchObject({ ok: false, code: 'no_skill_md' })
    rmSync(src, { recursive: true, force: true })
  })

  it('rejects a folder whose SKILL.md has an invalid name', () => {
    const src = mkdtempSync(join(tmpdir(), 'swarm-import-'))
    writeFileSync(join(src, 'SKILL.md'), '---\nname: Bad_Name\ndescription: d\n---\n\nb')
    const store = createSkillStore({ dir })
    const r = store.importFolder(src)
    expect(r).toMatchObject({ ok: false, code: 'invalid' })
    rmSync(src, { recursive: true, force: true })
  })

  it('refuses to overwrite an existing skill unless overwrite=true', () => {
    const src = mkdtempSync(join(tmpdir(), 'swarm-import-'))
    writeFileSync(join(src, 'SKILL.md'), '---\nname: dup\ndescription: first\n---\n\nv1')
    const store = createSkillStore({ dir })
    expect(store.importFolder(src).ok).toBe(true)

    writeFileSync(join(src, 'SKILL.md'), '---\nname: dup\ndescription: second\n---\n\nv2')
    expect(store.importFolder(src)).toMatchObject({ ok: false, code: 'exists' })

    const r = store.importFolder(src, true)
    expect(r.ok).toBe(true)
    expect(store.get('dup')?.body).toBe('v2')
    rmSync(src, { recursive: true, force: true })
  })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- src/service/skills/store.test.ts`
Expected: FAIL — `store.importFolder is not a function`.

- [ ] **Step 4: Implement `files` listing + `importFolder`**

In `src/service/skills/store.ts`, update the fs import on line 1 to add `cpSync`, `relative`, `sep`:

```ts
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
```

Add a file-walk helper above `createSkillStore`:

```ts
/** All file paths under `root`, relative to it, POSIX-separated and sorted. */
function listFilesRel(root: string): string[] {
  const out: string[] = []
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const full = join(abs, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'))
    }
  }
  if (existsSync(root)) walk(root)
  return out.sort()
}
```

Add `importFolder` to the `SkillStore` type:

```ts
export type SkillStore = {
  list(): Skill[]
  get(name: string): Skill | undefined
  reload(): void
  save(skill: Skill): SkillMutationResult
  importFolder(sourceDir: string, overwrite?: boolean): SkillMutationResult
  remove(name: string): SkillMutationResult
}
```

In `reload()`, populate `files` when pushing each skill. Replace the existing push line:

```ts
      const folder = join(dir, entry.name)
      try {
        skills.push({ ...parseSkill(readFileSync(file, 'utf8'), entry.name), filePath: file, files: listFilesRel(folder) })
      } catch (err) {
        log.warn({ msg: 'failed to parse skill', dir: entry.name, err: String(err) })
      }
```

Add the `importFolder` implementation (place it after `save`, before `remove`):

```ts
  const importFolder: SkillStore['importFolder'] = (sourceDir, overwrite) => {
    log.info({ msg: 'importFolder start', sourceDir, overwrite: overwrite ?? false })
    const skillMd = join(sourceDir, 'SKILL.md')
    if (!existsSync(skillMd)) {
      log.warn({ msg: 'importFolder missing SKILL.md', sourceDir })
      return { ok: false, code: 'no_skill_md', message: 'The selected folder has no SKILL.md file.' }
    }
    let parsed: Skill
    try {
      parsed = parseSkill(readFileSync(skillMd, 'utf8'), basename(sourceDir))
    } catch (err) {
      log.error({ msg: 'importFolder read failed', sourceDir, err: String(err) })
      return { ok: false, code: 'invalid', message: 'Could not read SKILL.md.' }
    }
    const checked = SkillSchema.safeParse(parsed)
    if (!checked.success)
      return { ok: false, code: 'invalid', message: checked.error.issues[0]?.message ?? 'invalid skill' }
    const target = join(dir, checked.data.name)
    if (existsSync(target) && !overwrite) {
      log.warn({ msg: 'importFolder name exists', name: checked.data.name })
      return { ok: false, code: 'exists', message: `A skill named "${checked.data.name}" already exists.` }
    }
    try {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      cpSync(sourceDir, target, { recursive: true })
    } catch (err) {
      log.error({ msg: 'importFolder copy failed', sourceDir, target, err: String(err) })
      return { ok: false, code: 'write_failed', message: String(err) }
    }
    reload()
    log.info({ msg: 'importFolder ok', name: checked.data.name, fileCount: listFilesRel(target).length })
    return { ok: true, skills: merged() }
  }
```

Add `importFolder` to the returned object:

```ts
  return {
    list: () => merged(),
    get: (name) => skills.find((s) => s.name === name) ?? builtins.find((b) => b.name === name),
    reload,
    save,
    importFolder,
    remove,
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/service/skills/store.test.ts`
Expected: PASS (all `parseSkill` + `createSkillStore` tests, including the 4 new ones).

- [ ] **Step 6: Format + commit**

```bash
npx biome check --write src/shared/types/skill.ts src/service/skills/store.ts src/service/skills/store.test.ts
git add src/shared/types/skill.ts src/service/skills/store.ts src/service/skills/store.test.ts
git commit -m "feat(skills): importFolder() copies a skill folder and lists its files"
```

---

### Task 2: Dispatcher — route `importSkill`

**Files:**
- Modify: `src/shared/types/service-ipc.ts` (add `'importSkill'` to `ServiceMethod`)
- Modify: `src/service/dispatcher.ts` (config field + `case 'importSkill'`)
- Test: `src/service/dispatcher.test.ts`

**Interfaces:**
- Consumes: `SkillStore.importFolder` (Task 1), `SkillMutationResult`.
- Produces: dispatcher method `'importSkill'` taking `[sourceDir: string, overwrite?: boolean]`, returning `SkillMutationResult`.

- [ ] **Step 1: Write the failing test**

In `src/service/dispatcher.test.ts`, add `importSkill` to the `mcpDeps` factory (after `deleteSkill`):

```ts
  importSkill: vi.fn().mockReturnValue({ ok: true, skills: [] }),
```

Add this test inside `describe('dispatcher', ...)`:

```ts
  it('importSkill forwards sourceDir and overwrite to the store', () => {
    const deps = mcpDeps()
    const dispatch = createDispatcher({ manager: mockManager(), registerProvider: vi.fn(), ...deps })
    const result = dispatch('importSkill', ['/tmp/my-skill', true])
    expect(deps.importSkill).toHaveBeenCalledWith('/tmp/my-skill', true)
    expect(result).toEqual({ ok: true, skills: [] })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/service/dispatcher.test.ts`
Expected: FAIL — `unknown method: importSkill`.

- [ ] **Step 3: Add the method to the wire protocol**

In `src/shared/types/service-ipc.ts`, add to the `ServiceMethod` union after `'deleteSkill'`:

```ts
  | 'deleteSkill'
  | 'importSkill'
```

- [ ] **Step 4: Add the dispatcher config field + case**

In `src/service/dispatcher.ts`, add to `DispatcherConfig` after `deleteSkill`:

```ts
  deleteSkill(name: string): SkillMutationResult
  importSkill(sourceDir: string, overwrite?: boolean): SkillMutationResult
```

Add the case after `case 'deleteSkill'`:

```ts
      case 'importSkill': {
        const [sourceDir, overwrite] = args as [string, boolean | undefined]
        return cfg.importSkill(sourceDir, overwrite)
      }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/service/dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 6: Format + commit**

```bash
npx biome check --write src/shared/types/service-ipc.ts src/service/dispatcher.ts src/service/dispatcher.test.ts
git add src/shared/types/service-ipc.ts src/service/dispatcher.ts src/service/dispatcher.test.ts
git commit -m "feat(skills): route importSkill through the dispatcher"
```

---

### Task 3: IPC plumbing — service-client, service wiring, main handler, preload

**Files:**
- Modify: `src/service/index.ts` (wire `importSkill` into dispatcher config)
- Modify: `src/main/service-client.ts` (type + impl of `importSkill`)
- Modify: `src/main/ipc/swarm-ipc.ts` (add `skills:import` handler with native dialog + dispose cleanup)
- Modify: `src/shared/types/ui.ts` (`SkillBridge.importFolder`)
- Modify: `src/preload/index.ts` (`skills.importFolder`)

**Interfaces:**
- Consumes: dispatcher `'importSkill'` (Task 2), `serviceClient.importSkill`.
- Produces:
  - `ServiceClient.importSkill(sourceDir: string, overwrite?: boolean): Promise<SkillMutationResult>`
  - `SkillBridge.importFolder(arg?: { sourceDir?: string; overwrite?: boolean }): Promise<SkillMutationResult & { sourceDir?: string }>` — exposed on `window.swarm.skills.importFolder`. (Named `importFolder`, not `import`, to avoid the TS `import(...)` reserved-word ambiguity in type position.)
  - IPC channel `'skills:import'` (main): opens the directory picker when `sourceDir` is absent; on `code:'exists'` echoes back the chosen `sourceDir` for an overwrite retry.

- [ ] **Step 1: Wire the store into the dispatcher config**

In `src/service/index.ts`, in the `createDispatcher({ ... })` config, after the `deleteSkill` line:

```ts
  deleteSkill: (name) => skillStore.remove(name),
  importSkill: (sourceDir, overwrite) => skillStore.importFolder(sourceDir, overwrite),
```

- [ ] **Step 2: Add `importSkill` to the service client**

In `src/main/service-client.ts`, add to the `ServiceClient` type after `deleteSkill`:

```ts
  deleteSkill(name: string): Promise<SkillMutationResult>
  importSkill(sourceDir: string, overwrite?: boolean): Promise<SkillMutationResult>
```

Add the implementation after the `deleteSkill` impl:

```ts
    deleteSkill(name) {
      return call('deleteSkill', [name])
    },
    importSkill(sourceDir, overwrite) {
      return call('importSkill', [sourceDir, overwrite])
    },
```

- [ ] **Step 3: Add the main IPC handler (native directory picker)**

In `src/main/ipc/swarm-ipc.ts`, in the Skills block (after the `skills:delete` handler, ~line 85), add:

```ts
  ipcMain.handle(
    'skills:import',
    async (e: Electron.IpcMainInvokeEvent, arg?: { sourceDir?: string; overwrite?: boolean }) => {
      let sourceDir = arg?.sourceDir
      if (!sourceDir) {
        const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined
        const res = parent
          ? await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
          : await dialog.showOpenDialog({ properties: ['openDirectory'] })
        if (res.canceled || res.filePaths.length === 0) {
          log.info({ msg: 'skills:import cancelled' })
          return { ok: false, code: 'cancelled', message: 'Import cancelled.' }
        }
        sourceDir = res.filePaths[0]
      }
      log.info({ msg: 'skills:import', sourceDir, overwrite: arg?.overwrite ?? false })
      const r = await serviceClient.importSkill(sourceDir, arg?.overwrite)
      // Echo the chosen dir back on a name clash so the renderer can retry with overwrite.
      if (!r.ok && r.code === 'exists') return { ...r, sourceDir }
      return r
    }
  )
```

In the `dispose()` block, after `ipcMain.removeHandler('skills:delete')`:

```ts
      ipcMain.removeHandler('skills:delete')
      ipcMain.removeHandler('skills:import')
```

- [ ] **Step 4: Add `importFolder` to the SkillBridge type**

In `src/shared/types/ui.ts`, update `SkillBridge`:

```ts
export type SkillBridge = {
  list(): Promise<Skill[]>
  save(skill: Skill): Promise<SkillMutationResult>
  remove(name: string): Promise<SkillMutationResult>
  importFolder(arg?: { sourceDir?: string; overwrite?: boolean }): Promise<SkillMutationResult & { sourceDir?: string }>
}
```

- [ ] **Step 5: Expose it in preload**

In `src/preload/index.ts`, add to the `skills` bridge object after `remove`:

```ts
const skills: SkillBridge = {
  list: () => ipcRenderer.invoke('skills:list') as Promise<Skill[]>,
  save: (skill: Skill) => ipcRenderer.invoke('skills:save', skill) as Promise<SkillMutationResult>,
  remove: (name: string) => ipcRenderer.invoke('skills:delete', name) as Promise<SkillMutationResult>,
  importFolder: (arg?: { sourceDir?: string; overwrite?: boolean }) =>
    ipcRenderer.invoke('skills:import', arg) as Promise<SkillMutationResult & { sourceDir?: string }>,
}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no errors). This is the verification for this glue task — every new signature lines up across processes.

- [ ] **Step 7: Format + commit**

```bash
npx biome check --write src/service/index.ts src/main/service-client.ts src/main/ipc/swarm-ipc.ts src/shared/types/ui.ts src/preload/index.ts
git add src/service/index.ts src/main/service-client.ts src/main/ipc/swarm-ipc.ts src/shared/types/ui.ts src/preload/index.ts
git commit -m "feat(skills): thread importSkill through IPC with a native folder picker"
```

---

### Task 4: Renderer — import button + read-only view with file tree

**Files:**
- Modify: `src/renderer/src/components/views/skills-view.tsx` (full rewrite — remove inline editor)

**Interfaces:**
- Consumes: `window.swarm.skills.importFolder` (Task 3), `window.swarm.skills.remove`, `useSkills()`, `Skill.files` (Task 1).
- Produces: the Skills page UI. No exports beyond the existing `SkillsView`.

- [ ] **Step 1: Replace the view with the import-folder + read-only version**

Overwrite `src/renderer/src/components/views/skills-view.tsx` with:

```tsx
import { useState } from 'react'
import { FolderInput, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { useSkills } from '@/hooks/use-skills'

export function SkillsView(): React.JSX.Element {
  const { skills, setSkills } = useSkills()
  const [expanded, setExpanded] = useState<string | null>(null)

  const remove = async (name: string): Promise<void> => {
    const r = await window.swarm.skills.remove(name)
    if (!r.ok) {
      toast.error(r.message)
      return
    }
    setSkills(r.skills)
  }

  const runImport = async (arg?: { sourceDir?: string; overwrite?: boolean }): Promise<void> => {
    const r = await window.swarm.skills.importFolder(arg)
    if (r.ok) {
      setSkills(r.skills)
      toast.success('Skill imported')
      return
    }
    if (r.code === 'cancelled') return
    if (r.code === 'exists' && r.sourceDir) {
      if (window.confirm(`${r.message} Overwrite it?`)) {
        await runImport({ sourceDir: r.sourceDir, overwrite: true })
      }
      return
    }
    toast.error(r.message)
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-xl">Skills</h2>
          <p className="text-muted-foreground text-sm">
            Reusable instruction folders. Import a folder containing a{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">SKILL.md</code> plus any scripts or resources. The
            agent sees each skill's name + description and loads the full body on demand via the{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">use_skill</code> tool.
          </p>
        </div>
        <Button className="shrink-0 gap-1.5" onClick={() => void runImport()}>
          <FolderInput className="size-4" />
          Import skill folder
        </Button>
      </div>

      {skills.length === 0 ? (
        <p className="text-muted-foreground text-sm">No skills yet. Import one above.</p>
      ) : (
        skills.map((s) => (
          <div className="rounded-xl border bg-card p-4" key={s.name}>
            <div className="flex items-start gap-3">
              <button
                className="min-w-0 flex-1 text-left"
                onClick={() => setExpanded(expanded === s.name ? null : s.name)}
                type="button"
              >
                <p className="truncate font-medium text-sm">{s.name}</p>
                <p className="text-muted-foreground text-sm">{s.description}</p>
              </button>
              <Button
                aria-label="Delete skill"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => void remove(s.name)}
                size="icon"
                variant="ghost"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            {expanded === s.name && (
              <div className="mt-3 flex flex-col gap-3 border-t pt-3">
                {s.files && s.files.length > 0 && (
                  <div>
                    <p className="mb-1 font-medium text-muted-foreground text-xs">Files</p>
                    <ul className="font-mono text-xs">
                      {s.files.map((f) => (
                        <li className="text-muted-foreground" key={f}>
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs">
                  {s.body}
                </pre>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck:web`
Expected: PASS. Confirms the removed `Input`/`Textarea`/`Pencil`/`Plus` imports left no dangling references and `Skill.files` is typed.

- [ ] **Step 3: Lint the file (catches unused imports)**

Run: `npx biome check --write src/renderer/src/components/views/skills-view.tsx`
Expected: No remaining errors; no unused-import warnings.

- [ ] **Step 4: Manual verification in the app**

Use the run-desktop skill to launch the app. Open the **Skills** page. Verify:
1. The header button reads "Import skill folder"; there is no "New skill" form.
2. Clicking it opens a native directory picker.
3. Import a test folder containing `SKILL.md` + `scripts/run.sh` → it appears in the list; clicking the row expands a read-only body and a Files list showing `SKILL.md` and `scripts/run.sh`.
4. Importing the same-named folder again prompts an overwrite confirm.
5. The trash icon deletes the skill.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/views/skills-view.tsx
git commit -m "feat(skills): import-folder UI with read-only view and file tree"
```

---

### Task 5: Full verification

- [ ] **Step 1: Run the full verify suite**

Run: `pnpm verify`
Expected: typecheck + lint + all tests + native-feel check PASS.

- [ ] **Step 2: If anything fails, fix and re-run before declaring done.**

---

## Notes for the implementer

- **Why copy instead of reference:** the agent's `use_skill` injects `<skill location="<filePath>">` and resolves bundled assets relative to that dir (`src/service/tools/skill.ts`). Copying into `userData/skills/<name>/` keeps `filePath` inside app data so this works and the skill survives the user moving/deleting the original folder.
- **`cpSync` recursive** copies the whole tree including any `scripts/`, `references/`, nested dirs — exactly what a packaged skill needs.
- **Builtins have no `files`/`filePath`** (they are in-memory). The read-only view guards with `s.files && s.files.length > 0`, so builtins simply show their body with no Files section.
- **Backend `save()` stays** even though the UI no longer calls it (surgical-change rule); its tests remain green.
```
