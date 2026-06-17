# Image Attachments (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users attach images to a message and have the model receive them, end-to-end, with strict vision-model gating and reload-persistent thumbnails.

**Architecture:** Thread an `attachments: Attachment[]` (base64 images) through the whole `submitGoal` chain into `agent.prompt(goal, images)`; persist on the `tasks` table; gate the composer's attach control on the active model's `input` capability (computed in `main` via pi-ai, which the main bundle already inlines); render thumbnails in the transcript.

**Tech Stack:** Electron (main+service share one rollup bundle that inlines pi-ai), React 19, TanStack Query, Zod, better-sqlite3, ai-elements `PromptInput`, Vitest (Electron-as-node).

**Commands:**
- Single test file: `npm test -- <path>`
- Full suite: `npm test`
- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Format one file: `npx biome check --write <file>` (never `npm run check`)

**Verified facts baked into this plan:**
- `agent.prompt(input: string, images?: ImageContent[])`; `ImageContent = { type: 'image'; data: string /* base64 */; mimeType: string }`.
- `tasks` table uses explicit columns; `saveTask`/`rowToTask` are at `src/service/conversation-store.ts`.
- `Model.input: ("text" | "image")[]`; pi-ai exports `getModel`/`getModels`; the `main` rollup input includes BOTH `src/main/index.ts` and `src/service/index.ts` and inlines pi-ai — so `src/main/**` can import pi-ai.
- The composer's `PromptInput onSubmit(message)` gives `message.files: FileUIPart[]` (each with a data URL `url` + `mediaType`), and `usePromptInputAttachments()` exposes `{ files, add, remove, openFileDialog }`.

---

### Task 1: Shared `Attachment` type + `Task.attachments`

**Files:**
- Modify: `src/shared/types/task.ts`
- Modify: `src/service/session-manager.ts` (the two `Task` object literals)
- Test: `src/shared/types/task.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/shared/types/task.test.ts`:

```ts
import { TaskSchema } from './task'

describe('TaskSchema.attachments', () => {
  const base = {
    id: '01234567890123456789012345',
    parentId: null,
    agentDefId: 'default',
    goal: 'g',
    status: 'pending',
    assignedWorkerId: null,
    toolAllowlist: [],
    budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    history: [],
    result: null,
    createdAt: 1,
    startedAt: null,
    endedAt: null,
  }

  it('defaults attachments to [] when omitted', () => {
    const t = TaskSchema.parse(base)
    expect(t.attachments).toEqual([])
  })

  it('accepts image attachments', () => {
    const t = TaskSchema.parse({ ...base, attachments: [{ data: 'AAAA', mimeType: 'image/png', name: 'a.png' }] })
    expect(t.attachments[0]).toEqual({ data: 'AAAA', mimeType: 'image/png', name: 'a.png' })
  })
})
```

(If `task.test.ts` doesn't exist, create it with `import { describe, expect, it } from 'vitest'` at the top.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/shared/types/task.test.ts`
Expected: FAIL — `attachments` undefined / unknown key stripped.

- [ ] **Step 3: Add the schema**

In `src/shared/types/task.ts`, after the `ArtifactSchema`/`TaskResultSchema` block and before `TaskSchema`, add:

```ts
export const AttachmentSchema = z.object({
  data: z.string(), // base64-encoded bytes (no data: prefix)
  mimeType: z.string(),
  name: z.string().optional(),
})
export type Attachment = z.infer<typeof AttachmentSchema>
```

Then add this field inside `TaskSchema` (e.g. right after `history`):

```ts
  attachments: z.array(AttachmentSchema).default([]),
```

- [ ] **Step 4: Keep the `Task` literals compiling**

`z.array(...).default([])` makes `attachments` a required property on the inferred `Task` type, so the two hand-built `Task` literals must set it.

In `src/service/session-manager.ts`, in `submitGoal`'s `const task: Task = { ... }` (after `history: [],`) add:
```ts
        attachments: [],
```
And in `spawnChild`'s `const childTask: Task = { ... }` (after `history: [],`) add:
```ts
      attachments: [],
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test -- src/shared/types/task.test.ts` → PASS
Run: `npm run typecheck` → PASS

- [ ] **Step 6: Commit**

```bash
npx biome check --write src/shared/types/task.ts src/shared/types/task.test.ts src/service/session-manager.ts
git add src/shared/types/task.ts src/shared/types/task.test.ts src/service/session-manager.ts
git commit -m "feat(types): add Attachment type and Task.attachments"
```

---

### Task 2: Persist attachments in the conversation store

**Files:**
- Modify: `src/service/conversation-store.ts`
- Test: `src/service/conversation-store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/service/conversation-store.test.ts` a test that mirrors the existing save/load pattern in that file (reuse its existing helper for creating a store + session; match how other tests build a `Task`). Add:

```ts
it('round-trips task attachments', () => {
  const store = createConversationStore(':memory:')
  store.createSession('ses_att', { id: 'anthropic', model: 'claude', apiKey: 'k' } as never)
  const task = {
    id: '01HZZZZZZZZZZZZZZZZZZZZZZZZ',
    parentId: null,
    agentDefId: 'default',
    goal: 'look at this',
    status: 'pending' as const,
    assignedWorkerId: null,
    toolAllowlist: [],
    budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
    history: [],
    attachments: [{ data: 'AAAA', mimeType: 'image/png', name: 'a.png' }],
    result: null,
    createdAt: 1,
    startedAt: null,
    endedAt: null,
  }
  store.saveTask(task, 'ses_att')
  const loaded = store.getSessionTasks('ses_att')
  expect(loaded[0].attachments).toEqual([{ data: 'AAAA', mimeType: 'image/png', name: 'a.png' }])
  store.close()
})
```

(Adjust the store/session creation calls to match the existing tests in this file — read the top of `conversation-store.test.ts` first and reuse its exact setup helpers and provider shape.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/service/conversation-store.test.ts`
Expected: FAIL — `loaded[0].attachments` is `undefined` (no column / not mapped).

- [ ] **Step 3: Add the column to the DDL**

In `src/service/conversation-store.ts`, in the `CREATE TABLE IF NOT EXISTS tasks (...)` block, add a column after `history TEXT NOT NULL DEFAULT '[]',`:

```sql
      attachments         TEXT NOT NULL DEFAULT '[]',
```

- [ ] **Step 4: Add an idempotent migration for existing DBs**

Immediately after the `db.exec(\`...CREATE TABLE...\`)` schema block runs (find where the schema string is executed), add a guarded `ALTER TABLE` so pre-existing databases gain the column:

```ts
// Additive migration: older DBs created before image attachments lack this column.
const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]
if (!taskCols.some((c) => c.name === 'attachments')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'`)
}
```

- [ ] **Step 5: Write + map the column**

In the `stmtInsertTask` prepared statement, add `attachments` to the column list and one more `?`:
```ts
  const stmtInsertTask = db.prepare(
    `INSERT OR REPLACE INTO tasks
     (id, session_id, parent_id, goal, status, result, budget, used,
      agent_def_id, assigned_worker_id, tool_allowlist, history, attachments,
      created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
```
In `saveTask`, pass the value in the SAME position (right after `JSON.stringify(task.history),`):
```ts
        JSON.stringify(task.history),
        JSON.stringify(task.attachments ?? []),
```
In `rowToTask`, add (e.g. after the `history:` line):
```ts
    attachments: JSON.parse((row.attachments as string) ?? '[]') as Task['attachments'],
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm test -- src/service/conversation-store.test.ts` → PASS
Run: `npm run typecheck` → PASS

- [ ] **Step 7: Commit**

```bash
npx biome check --write src/service/conversation-store.ts src/service/conversation-store.test.ts
git add src/service/conversation-store.ts src/service/conversation-store.test.ts
git commit -m "feat(store): persist task attachments (additive tasks.attachments column)"
```

---

### Task 3: Thread attachments through the service to `agent.prompt`

**Files:**
- Modify: `src/service/dispatcher.ts`, `src/service/session-manager.ts`, `src/service/agent-runner.ts`

No new test (covered by Task 1/2 unit tests + the manual run); verify via typecheck.

- [ ] **Step 1: Dispatcher reads attachments**

In `src/service/dispatcher.ts`, the `submitGoal` case:
```ts
      case 'submitGoal': {
        const [sessionId, goal] = args as [string, string]
        return manager.submitGoal(sessionId, goal)
      }
```
becomes:
```ts
      case 'submitGoal': {
        const [sessionId, goal, attachments] = args as [string, string, import('@shared/types/task').Attachment[] | undefined]
        return manager.submitGoal(sessionId, goal, attachments)
      }
```

- [ ] **Step 2: SessionManager accepts + stores + broadcasts attachments**

In `src/service/session-manager.ts`:

Update the interface signature (the `submitGoal(...)` line in the `SessionManager` type):
```ts
  submitGoal(sessionId: string, goal: string, attachments?: import('@shared/types/task').Attachment[], agentDef?: AgentDefinition): { taskId: string }
```

Update the implementation signature and the task literal + broadcast:
```ts
    submitGoal(sessionId, goal, attachments = [], agentDef = DEFAULT_AGENT_DEF) {
```
Set `attachments` on the task literal (replace the `attachments: [],` added in Task 1 with the param):
```ts
        attachments,
```
Include attachments in the broadcast:
```ts
      broadcaster.broadcast('task.created', { sessionId, taskId, goal, attachments, ts: now })
```

- [ ] **Step 3: agent-runner passes images to the prompt**

In `src/service/agent-runner.ts`, add the `ImageContent` import to the existing pi-ai/pi-agent-core type imports near the top:
```ts
import type { ImageContent } from '@earendil-works/pi-ai'
```
Replace the prompt call:
```ts
        await agent.prompt(task.goal)
```
with:
```ts
        const images: ImageContent[] = task.attachments.map((a) => ({ type: 'image', data: a.data, mimeType: a.mimeType }))
        await agent.prompt(task.goal, images.length > 0 ? images : undefined)
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck` → PASS

- [ ] **Step 5: Commit**

```bash
npx biome check --write src/service/dispatcher.ts src/service/session-manager.ts src/service/agent-runner.ts
git add src/service/dispatcher.ts src/service/session-manager.ts src/service/agent-runner.ts
git commit -m "feat(service): forward image attachments into agent.prompt"
```

---

### Task 4: Thread attachments through main → preload → renderer API

**Files:**
- Modify: `src/shared/types/ui.ts`, `src/main/service-client.ts`, `src/main/ipc/swarm-ipc.ts`, `src/preload/index.ts`, `src/renderer/src/lib/api.ts`

Verify via typecheck (no new unit test; the value just rides through).

- [ ] **Step 1: SwarmBridge type**

In `src/shared/types/ui.ts`, add the import (top of file, with the other type imports):
```ts
import type { Attachment } from './task'
```
Change the bridge method:
```ts
  submitGoal(sessionId: string, goal: string, attachments?: Attachment[]): Promise<SubmitGoalResult>
```

- [ ] **Step 2: service-client**

In `src/main/service-client.ts`, the interface line:
```ts
  submitGoal(sessionId: string, goal: string, attachments?: import('@shared/types/task').Attachment[]): Promise<{ taskId: string }>
```
The implementation:
```ts
    submitGoal(sessionId, goal, attachments) {
      return call('submitGoal', [sessionId, goal, attachments])
    },
```

- [ ] **Step 3: main IPC handler**

In `src/main/ipc/swarm-ipc.ts`, update `submitGoal`:
```ts
  const submitGoal = async (
    _e: Electron.IpcMainInvokeEvent,
    sessionId: string,
    goal: string,
    attachments?: import('@shared/types/task').Attachment[]
  ): Promise<{ taskId: string }> => {
    if (typeof goal !== 'string' || goal.trim().length === 0) {
      throw new Error('goal must be a non-empty string')
    }
    const trimmedGoal = goal.trim()
    const { taskId } = await serviceClient.submitGoal(sessionId, trimmedGoal, attachments)
    log.info({ msg: 'task submitted', sessionId, taskId, attachments: attachments?.length ?? 0 })
    return { taskId }
  }
```

- [ ] **Step 4: preload**

In `src/preload/index.ts`:
```ts
  submitGoal: (sessionId, goal, attachments) =>
    ipcRenderer.invoke('swarm:submitGoal', sessionId, goal, attachments) as Promise<SubmitGoalResult>,
```

- [ ] **Step 5: renderer api**

In `src/renderer/src/lib/api.ts`, add the import:
```ts
import type { Attachment, Task } from '@shared/types/task'
```
(Combine with the existing `Task` import — replace the existing `import type { Task } from '@shared/types/task'` line.) Then:
```ts
  submitGoal: (sessionId: string, goal: string, attachments?: Attachment[]): Promise<SubmitGoalResult> =>
    window.swarm.submitGoal(sessionId, goal, attachments),
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck` → PASS

- [ ] **Step 7: Commit**

```bash
npx biome check --write src/shared/types/ui.ts src/main/service-client.ts src/main/ipc/swarm-ipc.ts src/preload/index.ts src/renderer/src/lib/api.ts
git add src/shared/types/ui.ts src/main/service-client.ts src/main/ipc/swarm-ipc.ts src/preload/index.ts src/renderer/src/lib/api.ts
git commit -m "feat(ipc): carry attachments on submitGoal across the bridge"
```

---

### Task 5: Vision capability → `supportsImages` on the providers view

**Files:**
- Create: `src/main/providers/capabilities.ts`
- Test: `src/main/providers/capabilities.test.ts`
- Modify: `src/shared/types/provider.ts`, `src/main/providers/redact.ts`, `src/main/providers/redact.test.ts`

- [ ] **Step 1: Write the failing test for the pure decision**

Create `src/main/providers/capabilities.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { modelSupportsImagesFromInput } from './capabilities'

describe('modelSupportsImagesFromInput', () => {
  it('true when the model input includes image', () => {
    expect(modelSupportsImagesFromInput(['text', 'image'])).toBe(true)
  })
  it('false when image is absent', () => {
    expect(modelSupportsImagesFromInput(['text'])).toBe(false)
  })
  it('true (permissive) when input is unknown', () => {
    expect(modelSupportsImagesFromInput(undefined)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/main/providers/capabilities.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `src/main/providers/capabilities.ts`:

```ts
import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai'
import { getModel } from '@earendil-works/pi-ai'
import type { ApiStyle, ProviderId } from '@shared/types/provider'

// pi-ai's getModel is strictly typed per known provider; loosen it like agent-runner does.
const getModelLoose = getModel as unknown as (provider: KnownProvider, modelId: string) => Model<Api> | undefined

/** Pure decision: unknown capability is permissive (don't block models we can't introspect). */
export function modelSupportsImagesFromInput(input: readonly string[] | undefined): boolean {
  return input ? input.includes('image') : true
}

/** Look up a model's image capability from the pi-ai registry. */
export function modelSupportsImages(providerId: ProviderId, apiStyle: ApiStyle | undefined, model: string): boolean {
  const lookup = (providerId === 'custom' ? (apiStyle ?? 'openai') : providerId) as KnownProvider
  return modelSupportsImagesFromInput(getModelLoose(lookup, model)?.input)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- src/main/providers/capabilities.test.ts` → PASS

- [ ] **Step 5: Add `supportsImages` to the view schema**

In `src/shared/types/provider.ts`, in `ProviderRowView`:
```ts
const ProviderRowView = z.object({
  model: ModelString,
  hasKey: z.boolean(),
  supportsImages: z.boolean(),
  baseUrl: BaseUrlString.optional(),
  customModels: CustomModelsList.optional(),
  apiStyle: ApiStyle.optional(),
})
```

- [ ] **Step 6: Compute it in `toView`**

In `src/main/providers/redact.ts`, import the helper and pass the provider id into `projectRow`:

```ts
import type { ProviderId } from '@shared/types/provider'
import { modelSupportsImages } from './capabilities'
```
Change `projectRow` to take the id and set `supportsImages`:
```ts
function projectRow(
  id: ProviderId,
  row: ProvidersStateOnDisk['providers']['anthropic']
): ProvidersStateView['providers']['anthropic'] {
  if (!row) return null
  return {
    model: row.model,
    hasKey: true,
    supportsImages: modelSupportsImages(id, row.apiStyle, row.model),
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(row.customModels && row.customModels.length > 0 ? { customModels: row.customModels } : {}),
    ...(row.apiStyle ? { apiStyle: row.apiStyle } : {}),
  }
}
```
And in `toView`:
```ts
    providers: {
      anthropic: projectRow('anthropic', state.providers.anthropic),
      openai: projectRow('openai', state.providers.openai),
      custom: projectRow('custom', state.providers.custom),
    },
```

- [ ] **Step 7: Fix the existing `redact.test.ts` expectations**

`redact.test.ts` asserts on projected rows; add `supportsImages` to each expected row object. Read the file and, for every `toMatchObject`/`toEqual` that includes `hasKey: true`, add `supportsImages: expect.any(Boolean)` (or the concrete boolean if the test uses a known model id). Keep assertions minimal — `supportsImages: expect.any(Boolean)` is sufficient where the model id isn't a known registry entry.

- [ ] **Step 8: Run tests + typecheck**

Run: `npm test -- src/main/providers/capabilities.test.ts src/main/providers/redact.test.ts` → PASS
Run: `npm run typecheck` → PASS

- [ ] **Step 9: Commit**

```bash
npx biome check --write src/main/providers/capabilities.ts src/main/providers/capabilities.test.ts src/shared/types/provider.ts src/main/providers/redact.ts src/main/providers/redact.test.ts
git add src/main/providers/capabilities.ts src/main/providers/capabilities.test.ts src/shared/types/provider.ts src/main/providers/redact.ts src/main/providers/redact.test.ts
git commit -m "feat(providers): expose per-model supportsImages to the renderer"
```

---

### Task 6: Renderer helper — `FileUIPart` → `Attachment`

**Files:**
- Create: `src/renderer/src/lib/attachments.ts`
- Test: `src/renderer/src/lib/attachments.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/attachments.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { imageAttachmentsFrom } from './attachments'

describe('imageAttachmentsFrom', () => {
  it('parses image data URLs into Attachments', () => {
    const out = imageAttachmentsFrom([
      { type: 'file', mediaType: 'image/png', filename: 'a.png', url: 'data:image/png;base64,AAAB' },
    ])
    expect(out).toEqual([{ data: 'AAAB', mimeType: 'image/png', name: 'a.png' }])
  })

  it('skips non-image files', () => {
    const out = imageAttachmentsFrom([{ type: 'file', mediaType: 'text/plain', url: 'data:text/plain;base64,AAAB' }])
    expect(out).toEqual([])
  })

  it('skips files without a base64 data URL', () => {
    const out = imageAttachmentsFrom([{ type: 'file', mediaType: 'image/png', url: 'https://example.com/a.png' }])
    expect(out).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/renderer/src/lib/attachments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/renderer/src/lib/attachments.ts`:

```ts
import type { Attachment } from '@shared/types/task'

// The minimal shape we need from the composer's FileUIPart.
type FileLike = { mediaType?: string; filename?: string; url?: string }

/** Keep only image/* files whose url is a base64 data URL; convert to Attachment[]. */
export function imageAttachmentsFrom(files: readonly FileLike[]): Attachment[] {
  const out: Attachment[] = []
  for (const f of files) {
    if (!f.mediaType?.startsWith('image/')) continue
    const match = f.url?.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) continue
    out.push({ data: match[2], mimeType: f.mediaType, ...(f.filename ? { name: f.filename } : {}) })
  }
  return out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- src/renderer/src/lib/attachments.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
npx biome check --write src/renderer/src/lib/attachments.ts src/renderer/src/lib/attachments.test.ts
git add src/renderer/src/lib/attachments.ts src/renderer/src/lib/attachments.test.ts
git commit -m "feat(ui): FileUIPart→Attachment image conversion helper"
```

---

### Task 7: Carry attachments into the transcript

**Files:**
- Modify: `src/shared/types/ui.ts` (task.created event), `src/renderer/src/lib/apply-event.ts`, `src/renderer/src/lib/replay.ts`, `src/renderer/src/lib/task-segments.ts`, `src/renderer/src/components/conversation-thread.tsx`
- Test: `src/renderer/src/lib/task-segments.test.ts`

- [ ] **Step 1: Add attachments to the `task.created` event**

In `src/shared/types/ui.ts`, change the `task.created` event (it now imports `Attachment` from Task 4):
```ts
  | { kind: 'task.created'; sessionId: string; taskId: string; goal: string; attachments?: Attachment[]; ts: number }
```

- [ ] **Step 2: Write the failing taskSegments test**

In `src/renderer/src/lib/task-segments.test.ts`, the `rec()` helper builds a `TaskRecord`; add an `attachments` arg and a test. Replace the existing `rec` with:
```ts
function rec(events: TaskRecord['events'], attachments: TaskRecord['attachments'] = []): TaskRecord {
  return {
    id: 't1',
    sessionId: 's1',
    goal: 'do x',
    status: 'running',
    workerId: null,
    summary: null,
    startedAt: 1,
    attachments,
    events,
  }
}
```
Add a test:
```ts
it('carries attachments on the user segment', () => {
  const segs = taskSegments(rec([], [{ data: 'AAAA', mimeType: 'image/png', name: 'a.png' }]))
  const user = segs.find((s) => s.kind === 'user')
  expect(user && 'attachments' in user && user.attachments).toEqual([
    { data: 'AAAA', mimeType: 'image/png', name: 'a.png' },
  ])
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- src/renderer/src/lib/task-segments.test.ts`
Expected: FAIL — `TaskRecord` has no `attachments`; user segment has no `attachments`.

- [ ] **Step 4: TaskRecord + apply-event carry attachments**

In `src/renderer/src/lib/apply-event.ts`:
- Add the import: `import type { Attachment } from '@shared/types/task'`
- Add to `TaskRecord`: `attachments: Attachment[]`
- In the `task.created` branch, set `attachments: e.attachments ?? []` on the `created` object.
- In the `idx === -1` stub object, set `attachments: []`.

- [ ] **Step 5: replay carries attachments (event AND record)**

In `src/renderer/src/lib/replay.ts`, `tasksToRecords` builds both the `task.created` event and the returned `TaskRecord` literal. Both need the stored attachments (the record literal is required to compile once `TaskRecord.attachments` is required).

The `task.created` event:
```ts
    const events: UIEvent[] = [{ kind: 'task.created', sessionId, taskId: t.id, goal: t.goal, attachments: t.attachments, ts: t.createdAt }]
```
And the returned record object — add `attachments: t.attachments` to the `return { id: t.id, sessionId, goal: t.goal, ... }` literal (alongside the existing fields).

- [ ] **Step 6: taskSegments user segment carries attachments**

In `src/renderer/src/lib/task-segments.ts`:
- Add `import type { Attachment } from '@shared/types/task'`.
- Change the `user` member of the `Segment` union to include attachments:
```ts
  | { kind: 'user'; text: string; attachments: Attachment[]; key: string; taskId: string }
```
- Set it on the first segment:
```ts
  const out: Segment[] = [{ kind: 'user', text: task.goal, attachments: task.attachments ?? [], key: `${task.id}-goal`, taskId: task.id }]
```

- [ ] **Step 7: Render thumbnails in ConversationThread**

In `src/renderer/src/components/conversation-thread.tsx`, in the `seg.kind === 'user'` branch, render thumbnails above the text inside `MessageContent`:
```tsx
          <MessageContent>
            {seg.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {seg.attachments.map((a, i) => (
                  <img
                    alt={a.name ?? 'attachment'}
                    className="size-20 rounded-lg border border-border/40 object-cover"
                    key={`${seg.key}-att-${i}`}
                    src={`data:${a.mimeType};base64,${a.data}`}
                  />
                ))}
              </div>
            )}
            <span className="whitespace-pre-wrap">{seg.text}</span>
          </MessageContent>
```

- [ ] **Step 8: Run tests + typecheck**

Run: `npm test -- src/renderer/src/lib/task-segments.test.ts` → PASS
Run: `npm run typecheck` → PASS

- [ ] **Step 9: Commit**

```bash
npx biome check --write src/shared/types/ui.ts src/renderer/src/lib/apply-event.ts src/renderer/src/lib/replay.ts src/renderer/src/lib/task-segments.ts src/renderer/src/components/conversation-thread.tsx
git add src/shared/types/ui.ts src/renderer/src/lib/apply-event.ts src/renderer/src/lib/replay.ts src/renderer/src/lib/task-segments.ts src/renderer/src/components/conversation-thread.tsx
git commit -m "feat(ui): carry image attachments into the transcript (thumbnails + replay)"
```

---

### Task 8: Composer — enable image attachments + gating

**Files:**
- Modify: `src/renderer/src/components/chat-input.tsx`, `src/renderer/src/components/views/tasks-view.tsx`, `src/renderer/src/hooks/use-tasks.ts`

Verify via typecheck + full suite (no new unit test for the React wiring; conversion is covered by Task 6).

- [ ] **Step 1: `useSubmitGoal` accepts attachments**

In `src/renderer/src/hooks/use-tasks.ts`, change `useSubmitGoal`'s mutation to take an object:
```ts
export function useSubmitGoal() {
  return useMutation({
    mutationFn: async ({ goal, attachments }: { goal: string; attachments?: import('@shared/types/task').Attachment[] }) => {
      let sessionId = useSessionsStore.getState().selectedSessionId
      if (!sessionId) {
        const created = await swarmApi.createSession()
        sessionId = created.sessionId
        useSessionsStore.getState().select(sessionId)
      }
      return swarmApi.submitGoal(sessionId, goal, attachments)
    },
  })
}
```

- [ ] **Step 1b: Update the `useSubmitGoal` tests for the new object argument**

`src/renderer/src/hooks/use-tasks.test.tsx` calls the mutation with a bare string and asserts the old call shape. Update both occurrences:

- Change `await result.current.mutateAsync('my goal')` → `await result.current.mutateAsync({ goal: 'my goal' })`
- Change `await result.current.mutateAsync('another goal')` → `await result.current.mutateAsync({ goal: 'another goal' })`
- Change the assertion `expect(api.swarmApi.submitGoal).toHaveBeenCalledWith('ses-test', 'my goal')` → `...toHaveBeenCalledWith('ses-test', 'my goal', undefined)`
- Change `expect(api.swarmApi.submitGoal).toHaveBeenCalledWith('ses-existing', 'another goal')` → `...toHaveBeenCalledWith('ses-existing', 'another goal', undefined)`

(The two `vi.spyOn(... 'submitGoal').mockImplementation((sessionId, goal) => ...)` lines still compile — the extra `attachments` arg is simply ignored.)

- [ ] **Step 2: ChatInput — props, attachments, gating, preview, submit**

Overwrite `src/renderer/src/components/chat-input.tsx` with:

```tsx
import type { Attachment } from '@shared/types/task'
import type { ProviderId, ProvidersStateView } from '@shared/types/provider'
import type { ChatStatus } from 'ai'
import { Paperclip, X } from 'lucide-react'
import { useMemo } from 'react'

import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input'
import { useProviders } from '@/hooks/use-providers'
import { imageAttachmentsFrom } from '@/lib/attachments'

type Props = {
  onSubmit: (goal: string, attachments?: Attachment[]) => void | Promise<void>
  disabled?: boolean
  status?: ChatStatus
  onStop?: () => void
  supportsImages?: boolean
}

type ModelOption = { providerId: ProviderId; modelId: string; key: string }

const PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'openai', 'custom'] as const
const MAX_FILES = 4
const MAX_FILE_SIZE = 5 * 1024 * 1024

function buildModelOptions(state: ProvidersStateView): ModelOption[] {
  const out: ModelOption[] = []
  for (const id of PROVIDER_IDS) {
    const row = state.providers[id]
    if (!row?.hasKey) continue
    const seen = new Set<string>()
    for (const m of [row.model, ...(row.customModels ?? [])]) {
      if (seen.has(m)) continue
      seen.add(m)
      out.push({ providerId: id, modelId: m, key: `${id}::${m}` })
    }
  }
  return out
}

// Thumbnail strip + attach button; must be a child of PromptInput (uses its attachments context).
function AttachBar({ supportsImages }: { supportsImages: boolean }): React.JSX.Element {
  const attachments = usePromptInputAttachments()
  return (
    <>
      {attachments.files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1 pb-1">
          {attachments.files.map((f) => (
            <div className="relative" key={f.id}>
              <img alt={f.filename ?? 'attachment'} className="size-14 rounded-md border object-cover" src={f.url} />
              <button
                aria-label="Remove attachment"
                className="-right-1.5 -top-1.5 absolute rounded-full bg-background p-0.5 text-muted-foreground shadow hover:text-foreground"
                onClick={() => attachments.remove(f.id)}
                type="button"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <PromptInputButton
        disabled={!supportsImages}
        onClick={() => attachments.openFileDialog()}
        tooltip={supportsImages ? 'Attach images' : "This model can't read images"}
      >
        <Paperclip className="size-4" />
      </PromptInputButton>
    </>
  )
}

export function ChatInput({ onSubmit, disabled, status, onStop, supportsImages = true }: Props): React.JSX.Element {
  const { state } = useProviders()
  const options = useMemo(() => buildModelOptions(state), [state])
  const currentKey =
    state.active && state.providers[state.active] ? `${state.active}::${state.providers[state.active]!.model}` : ''

  const handleSubmit = async (message: PromptInputMessage): Promise<void> => {
    if (disabled) return
    const goal = message.text.trim()
    if (!goal) return
    const attachments = imageAttachmentsFrom(message.files)
    await onSubmit(goal, attachments.length > 0 ? attachments : undefined)
  }

  const onPickModel = async (key: string): Promise<void> => {
    const opt = options.find((o) => o.key === key)
    if (!opt) return
    if (state.active !== opt.providerId) await window.swarm.providers.setActive(opt.providerId)
    if (state.providers[opt.providerId]?.model !== opt.modelId) {
      await window.swarm.providers.setModel(opt.providerId, opt.modelId)
    }
  }

  return (
    <div className="shrink-0 px-4 pt-2 pb-4">
      <PromptInput
        accept="image/*"
        className="mx-auto max-w-3xl"
        maxFileSize={MAX_FILE_SIZE}
        maxFiles={MAX_FILES}
        onSubmit={handleSubmit}
      >
        <PromptInputBody>
          <PromptInputTextarea autoFocus disabled={disabled} placeholder="Message the swarm…" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <AttachBar supportsImages={supportsImages} />
            {options.length > 0 && (
              <PromptInputSelect onValueChange={(v) => void onPickModel(String(v))} value={currentKey}>
                <PromptInputSelectTrigger>
                  <PromptInputSelectValue placeholder="Model" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {options.map((o) => (
                    <PromptInputSelectItem key={o.key} value={o.key}>
                      {o.modelId}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            )}
          </PromptInputTools>
          <PromptInputSubmit disabled={disabled} onStop={onStop} status={status} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
```

- [ ] **Step 3: tasks-view passes attachments + supportsImages**

In `src/renderer/src/components/views/tasks-view.tsx`, update the `<ChatInput>` usage:
```tsx
        <ChatInput
          disabled={!ready}
          onStop={() => {
            if (activeTask) cancelTask.mutate({ sessionId: activeTask.sessionId, taskId: activeTask.id })
          }}
          onSubmit={async (g, attachments) => {
            if (!ready) return
            await submitGoal.mutateAsync({ goal: g, attachments })
          }}
          status={activeTask ? (activeTask.status === 'pending' ? 'submitted' : 'streaming') : 'ready'}
          supportsImages={!!(state.active && state.providers[state.active]?.supportsImages)}
        />
```
This needs `state` from `useProviders`. `tasks-view.tsx` already calls `const { ready } = useProviders()` — change it to `const { ready, state } = useProviders()`.

- [ ] **Step 4: Typecheck + full suite + build**

Run: `npm run typecheck` → PASS
Run: `npm test` → all PASS
Run: `npm run build` → PASS

- [ ] **Step 5: Commit**

```bash
npx biome check --write src/renderer/src/components/chat-input.tsx src/renderer/src/components/views/tasks-view.tsx src/renderer/src/hooks/use-tasks.ts
git add src/renderer/src/components/chat-input.tsx src/renderer/src/components/views/tasks-view.tsx src/renderer/src/hooks/use-tasks.ts
git commit -m "feat(ui): enable image attachments in the composer with vision gating"
```

---

### Task 9: Manual verification

**Files:** none.

- [ ] **Step 1: Build**

Run: `npm run build` → green.

- [ ] **Step 2: Launch + exercise**

Run `pnpm dev` (the headless driver can't hold the window here). Then:
- With a vision-capable model active (e.g. a Claude/GPT vision model): the paperclip is enabled. Attach a PNG/JPg → a thumbnail chip appears in the composer with a remove (×). Type a message and send.
- Confirm: the sent user message shows the image thumbnail in the transcript, and the model's reply reflects the image content.
- Switch to a non-vision model (if one is configured): the paperclip is disabled with tooltip "This model can't read images".
- Reload / switch sessions and back: the user message still shows the thumbnail (persisted).
- Send a text-only message: behaves exactly as before (no regression).

---

## Notes

- Empty/omitted attachments preserve the existing text-only path at every layer.
- `ai@6` stays a (type-only) dependency; `ImageContent` comes from `@earendil-works/pi-ai` (service side only).
- Image bytes are stored base64 in both the `tasks.attachments` column (for transcript thumbnails) and the agent message snapshot (for model context on resume) — an accepted size cost of "persist for reload"; the 4×/5 MB caps bound it.
- Custom/unknown models default to attach-enabled (we can't introspect arbitrary endpoints); known text-only models are correctly gated off.
