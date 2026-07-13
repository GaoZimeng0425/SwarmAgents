# Import Skill Folder (multi-file skills) — Design

Date: 2026-06-22
Status: Approved (pending spec review)

## Problem

Today users add a skill through an inline form (`skills-view.tsx`) that captures
only `name` / `description` / `body` and writes a single `SKILL.md` via
`skillStore.save()`. This is the wrong model: a real skill is a *folder* that may
ship supporting `scripts/`, `references/`, and other assets. The form cannot
produce or carry those files.

The agent side already supports multi-file skills: `tools/skill.ts` `formatSkill`
wraps the body in `<skill location="<filePath>">` and tells the model
"References are relative to `<dir>`", so bundled files are reachable via the
fs/shell tools as long as the folder lives on disk and `filePath` points into it.
`skillStore.reload()` already keys only off `SKILL.md` and ignores sibling files,
so a folder copied in wholesale already works end to end. **The only gap is the
import/storage path.**

## Goal

Let users import a skill *folder from disk* (containing `SKILL.md` plus optional
scripts/resources). Folder import becomes the primary entry point; the inline
create/edit form is removed and the per-skill view becomes read-only (view +
delete, no body editing).

## Decisions

- **Storage = copy into userData (Approach A).** On import, recursively copy the
  whole folder into `userData/skills/<name>/`, matching existing user skills.
  `reload()` and `filePath` then work unchanged; the skill is self-contained and
  travels with app data. (Rejected: reference-in-place — breaks when the user
  moves/deletes the source and leaves `filePath` pointing outside app data.
  Rejected: zip packaging — YAGNI.)
- **Name source:** `SKILL.md` frontmatter `name`; fallback to the folder name.
- **Validation:** the chosen folder must contain `SKILL.md` and parse to a valid
  `name` (Zod rule `^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤64). Otherwise import fails with
  a coded error and nothing is written.
- **Name conflict:** if `userData/skills/<name>/` already exists, return
  `code: 'exists'`; the renderer confirms overwrite, then re-calls with
  `overwrite: true` which `rmSync`s the old folder first. Shadowing a builtin of
  the same name is allowed silently (existing `merged()` behavior).
- **Copy semantics:** entire tree copied as-is (`cpSync recursive`), no filtering.
- **Backend `save()` is kept** (no longer called by the UI) per surgical-change
  rule; `remove()`/`deleteSkill` stay in use.
- **Read-only view lists the resource file tree** so users see what was imported.

## Components & Changes

### 1. Shared type (`src/shared/types/skill.ts`)
Add `files?: string[]` to `SkillSchema` — relative paths of files inside the skill
folder (including `SKILL.md`), populated on load only (like `filePath`, not part
of the write input).

### 2. Service store (`src/service/skills/store.ts`)
- `reload()`: after parsing each skill, walk its folder recursively and populate
  `files` (paths relative to the skill dir, sorted).
- New `importFolder(sourceDir: string, overwrite?: boolean): SkillMutationResult`:
  1. Resolve `<sourceDir>/SKILL.md`; missing → `{ ok:false, code:'no_skill_md', message }`.
  2. `parseSkill` → validate `name` via `SkillSchema` (name+description+body);
     invalid → `{ ok:false, code:'invalid', message }`.
  3. Target `<dir>/<name>/`; if it exists and not `overwrite` →
     `{ ok:false, code:'exists', message }`. If `overwrite`, `rmSync` target first.
  4. `cpSync(sourceDir, target, { recursive:true })`; `reload()`;
     `{ ok:true, skills: merged() }`. Wrap in try/catch → `{ ok:false, code:'write_failed' }`.
  - Log entry (`importFolder start`, sourceDir), outcome (name, fileCount), and
    every catch at `error` (CLAUDE.md §5).
- Extend `SkillStore` type with `importFolder`.

### 3. Dispatcher (`src/service/dispatcher.ts`)
Add `importSkill(sourceDir, overwrite?)` to `DispatcherConfig` and a
`case 'importSkill'` that calls `store.importFolder`. Add `importSkill` to the
`ServiceMethod` union (`shared/types/service-ipc.ts`).

### 4. Service client (`src/main/service-client.ts`)
Add `importSkill(sourceDir: string, overwrite?: boolean): Promise<SkillMutationResult>`
→ `call('importSkill', [sourceDir, overwrite])`. Wire in `service/index.ts`
dispatcher config: `importSkill: (dir, ow) => skillStore.importFolder(dir, ow)`.

### 5. Main IPC (`src/main/ipc/swarm-ipc.ts`)
Add `ipcMain.handle('skills:import', async (_e, arg?: { sourceDir?: string; overwrite?: boolean }) => {...})`.
The single arg drives whether the native dialog opens:
- **No `sourceDir`** (first call): `dialog.showOpenDialog(win, { properties: ['openDirectory'] })`;
  user cancels → return `{ ok:false, code:'cancelled' }`. Then call
  `serviceClient.importSkill(selectedDir, false)`.
- **`sourceDir` present** (overwrite retry): skip the dialog, call
  `serviceClient.importSkill(arg.sourceDir, arg.overwrite)`.
- On `code:'exists'`, return the result **with `sourceDir`** attached so the
  renderer can re-call with `{ sourceDir, overwrite:true }`.
- Remove the handler on dispose (mirrors the pattern at lines 257–259).

### 6. Preload (`src/preload/index.ts` + `SkillBridge` in `shared/types/ui.ts`)
- `SkillBridge`: add
  `import(arg?: { sourceDir?: string; overwrite?: boolean }): Promise<SkillMutationResult & { sourceDir?: string }>`.
  Keep `list` and `remove`. `save` stays in the bridge type (backend kept) but is
  unused by the UI.
- `skills.import` → `ipcRenderer.invoke('skills:import', arg)`.

### 7. Renderer (`src/renderer/src/components/views/skills-view.tsx`)
- Delete `SkillEditor` and the `draft` state / "New skill" button.
- Top action button → **"Import skill folder"** (`FolderInput`/`FolderPlus` icon)
  calling `window.swarm.skills.import()`.
  - On `code:'exists'`: `confirm("Skill '<name>' exists — overwrite?")`; if yes,
    re-call `import({ sourceDir, overwrite:true })`.
  - On `code:'cancelled'`: no-op. Other errors → `toast.error(message)`.
  - On success: `setSkills(r.skills)` + success toast.
- Per-skill card: keep name/description; clicking expands a **read-only** view
  showing the rendered body and a **file tree** from `skill.files`
  (relative paths). Keep 🗑️ delete; remove ✏️ edit.

## Data Flow

```
"Import skill folder"
 → window.swarm.skills.import()
 → ipcMain 'skills:import' → dialog.showOpenDialog (openDirectory)
 → serviceClient.importSkill(dir)
 → dispatcher 'importSkill' → store.importFolder(dir)
 → cpSync(dir → userData/skills/<name>/) → reload() (populates filePath + files)
 → { ok, skills } → renderer refresh
On exists: renderer confirms → import({ sourceDir, overwrite:true }) → rmSync + copy
Agent: use_skill → formatSkill injects location=<userData copy SKILL.md>;
       bundled files reachable via fs/shell relative to that dir (existing).
```

## Error Handling

Coded `SkillMutationResult` failures, surfaced as toasts:
`no_skill_md`, `invalid`, `exists` (→ confirm flow), `write_failed`, plus IPC-only
`cancelled`. Every service-side catch logs at `error` before returning.

## Testing (TDD)

- `store.test.ts`:
  - import a folder with `SKILL.md` + `scripts/run.sh` → `list()` contains the
    skill, `files` includes both, and `scripts/run.sh` exists under userData.
  - missing `SKILL.md` → `code:'no_skill_md'`.
  - invalid name → `code:'invalid'`.
  - existing name without overwrite → `code:'exists'`; with `overwrite:true` →
    `ok:true` and old contents replaced.
- `dispatcher.test.ts`: `importSkill` routes to `store.importFolder` with args.
- Renderer: no existing skills-view test; add a light test only if cheap,
  otherwise rely on manual verification via the run-desktop skill.

## Out of Scope

- Importing a single loose `.md` file (folder-only by request).
- Install-from-URL / marketplace.
- Editing bundled files in-app (read-only view only).
