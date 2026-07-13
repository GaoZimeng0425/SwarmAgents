# In-view Agent CRUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users create, edit, duplicate, and delete agents from the Agents settings view via a right-side Sheet form, with built-ins read-only.

**Architecture:** Add an IPC write path for agents mirroring the existing skills CRUD chain (service-ipc method union → dispatcher → service/index → swarm-ipc handlers → preload bridge → renderer api), reusing the agent store's existing `save`/`remove`. `listAgents()` tags each agent with a derived `builtin` flag. A prop-driven `AgentFormSheet` plus a `useAgentMutations` hook drive create/edit/duplicate/delete from `OrgTreeView`.

**Tech Stack:** TypeScript, Electron IPC, React, @tanstack/react-query, Radix-based Sheet/AlertDialog, vitest + @testing-library/react (jsdom for `src/renderer/**`).

## Global Constraints

- Mirror the skills CRUD pattern exactly (`saveSkill`/`deleteSkill` → `skills:save`/`skills:delete` → `window.swarm.skills.save/remove`).
- `AgentDefinitionSchema` is UNCHANGED — `builtin` is a list-time view field, never persisted.
- Built-ins are read-only: no edit, no delete; only Duplicate (which clears `id`).
- Reuse the store's existing `save`/`remove` (incl. Spec 1 `parentId` validation: `self_parent`/`unknown_parent`/`cycle`). Do not reimplement validation.
- `id` is editable on create/duplicate, read-only on edit (it is the on-disk folder name).
- Empty optional fields are omitted from the assembled `AgentDefinition`, never sent as `""`.
- Code comments and commit messages in English.
- Typecheck with `npm run typecheck` (passes `--composite false`; raw `tsc -p tsconfig.web.json` emits unrelated TS6307 noise).
- Tests run with `npm test -- <path-filter>`; renderer tests auto-run under jsdom.

---

### Task 1: Shared mutation types + `store.isBuiltin`

**Files:**
- Modify: `src/shared/types/agent.ts`
- Modify: `src/service/agents/store.ts`
- Test: `src/service/agents/store.test.ts`

**Interfaces:**
- Produces:
  - `AgentMutationResult` (moved to `@shared/types/agent`) — `{ ok: true; agents: AgentDefinition[] } | { ok: false; code: string; message: string }`.
  - `AgentListItem = AgentDefinition & { builtin: boolean }`.
  - `AgentStore.isBuiltin(id: string): boolean` — true when `id` ships as a built-in AND no user agent overrides it.

- [ ] **Step 1: Write the failing test**

Append to `src/service/agents/store.test.ts` (inside the `describe('createAgentStore', …)` block, after the override test ~line 108):

```ts
  it('isBuiltin: true for a shipped builtin, false once a user agent overrides it', () => {
    const store = createAgentStore({ dir, builtins: [builtin] })
    expect(store.isBuiltin('researcher')).toBe(true)
    store.save(def({ id: 'researcher', systemPrompt: 'user override' }))
    expect(store.isBuiltin('researcher')).toBe(false)
  })

  it('isBuiltin: false for a pure user agent and an unknown id', () => {
    const store = createAgentStore({ dir, builtins: [builtin] })
    store.save(def({ id: 'custom' }))
    expect(store.isBuiltin('custom')).toBe(false)
    expect(store.isBuiltin('nope')).toBe(false)
  })
```

(The existing test file already defines `builtin` and `def`; `builtin` has id `researcher`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/agents/store.test.ts`
Expected: FAIL — `store.isBuiltin` is not a function.

- [ ] **Step 3: Move `AgentMutationResult` to shared + add `AgentListItem`**

In `src/shared/types/agent.ts`, after the `AgentDefinition` type export, add:

```ts
/** Result of a create/update/delete on the agent store. */
export type AgentMutationResult =
  | { ok: true; agents: AgentDefinition[] }
  | { ok: false; code: string; message: string }

/** An agent as listed for the UI: the definition plus whether it is a
 *  read-only built-in (derived at list time, never persisted). */
export type AgentListItem = AgentDefinition & { builtin: boolean }
```

- [ ] **Step 4: Update the store to use the shared type + add `isBuiltin`**

In `src/service/agents/store.ts`:

Replace the local `AgentMutationResult` definition (line ~10) with a re-export so existing service consumers (`registry.ts`, `agent-runner.ts`) keep importing it from `./store`:

```ts
export type { AgentMutationResult } from '@shared/types/agent'
import type { AgentMutationResult } from '@shared/types/agent'
```

Add `isBuiltin` to the `AgentStore` type (after `remove`):

```ts
  /** True when `id` is a shipped built-in not overridden by a user agent. */
  isBuiltin(id: string): boolean
```

Implement it inside `createAgentStore` (the `agents` array holds user agents; `builtins` holds shipped ones) and add it to the returned object:

```ts
  const isBuiltin = (id: string): boolean =>
    builtins.some((b) => b.id === id) && !agents.some((a) => a.id === id)
```

```ts
  return {
    list: () => merged(),
    get: (id) => agents.find((a) => a.id === id) ?? builtins.find((b) => b.id === id),
    reload,
    save,
    remove,
    isBuiltin,
    watch,
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/service/agents/store.test.ts`
Expected: PASS (full file).

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/agent.ts src/service/agents/store.ts src/service/agents/store.test.ts
git commit -m "feat(agents): shared AgentMutationResult/AgentListItem + store.isBuiltin"
```

---

### Task 2: IPC write path (service → bridge → renderer api)

**Files:**
- Modify: `src/shared/types/service-ipc.ts`
- Modify: `src/service/ipc/dispatcher.ts`
- Modify: `src/service/index.ts`
- Modify: `src/main/ipc/swarm-ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types/ui.ts` (`AgentBridge`)
- Modify: `src/renderer/src/lib/api.ts`

**Interfaces:**
- Consumes: `AgentMutationResult`, `AgentListItem` (Task 1); `agentStore.save/remove/isBuiltin/list`.
- Produces:
  - `swarmApi.listAgents(): Promise<AgentListItem[]>`
  - `swarmApi.saveAgent(def: AgentDefinition): Promise<AgentMutationResult>`
  - `swarmApi.removeAgent(id: string): Promise<AgentMutationResult>`

- [ ] **Step 1: Extend the service-ipc method union**

In `src/shared/types/service-ipc.ts`, add after `'deleteSkill'`:

```ts
  | 'saveAgent'
  | 'deleteAgent'
```

- [ ] **Step 2: Extend the dispatcher**

In `src/service/ipc/dispatcher.ts`:

- Import the types at the top (where `AgentDefinition` is imported): ensure `AgentDefinition`, `AgentListItem`, `AgentMutationResult` are imported from `@shared/types/agent`.
- In `DispatcherConfig`, change `listAgents` and add the two mutations:

```ts
  listAgents(): AgentListItem[]
  saveAgent(def: AgentDefinition): AgentMutationResult
  deleteAgent(id: string): AgentMutationResult
```

- Add switch cases after the `deleteSkill` case:

```ts
      case 'saveAgent': {
        const [def] = args as [AgentDefinition]
        return cfg.saveAgent(def)
      }
      case 'deleteAgent': {
        const [id] = args as [string]
        return cfg.deleteAgent(id)
      }
```

- [ ] **Step 3: Wire the dispatcher config in service/index.ts**

In `src/service/index.ts`, replace the `listAgents` config line (~132) and add the mutations:

```ts
  listAgents: () => agentStore.list().map((a) => ({ ...a, builtin: agentStore.isBuiltin(a.id) })),
  saveAgent: (def) => agentStore.save(def),
  deleteAgent: (id) => agentStore.remove(id),
```

- [ ] **Step 4: Add main-process IPC handlers**

In `src/main/ipc/swarm-ipc.ts`, after the `skills:delete` handler (~line 86):

```ts
  ipcMain.handle('agents:save', (_e: Electron.IpcMainInvokeEvent, def: import('@shared/types/agent').AgentDefinition) =>
    serviceClient.saveAgent(def)
  )
  ipcMain.handle('agents:delete', (_e: Electron.IpcMainInvokeEvent, id: string) => serviceClient.deleteAgent(id))
```

And in the teardown block (where `skills:delete` is removed, ~line 307) add:

```ts
      ipcMain.removeHandler('agents:save')
      ipcMain.removeHandler('agents:delete')
```

Note: `serviceClient` is the typed proxy over the dispatcher; `saveAgent`/`deleteAgent` resolve via the method union from Step 1. If `serviceClient` is a hand-written interface in this file, add `saveAgent`/`deleteAgent` to it mirroring `saveSkill`/`deleteSkill`.

- [ ] **Step 5: Extend the preload bridge**

In `src/preload/index.ts`, in the `agents` bridge object (~line 167):

```ts
const agents: AgentBridge = {
  list: () => ipcRenderer.invoke('agents:list') as Promise<AgentListItem[]>,
  save: (def: AgentDefinition) => ipcRenderer.invoke('agents:save', def) as Promise<AgentMutationResult>,
  remove: (id: string) => ipcRenderer.invoke('agents:delete', id) as Promise<AgentMutationResult>,
}
```

Ensure `AgentListItem`, `AgentDefinition`, `AgentMutationResult` are imported from `@shared/types/agent` at the top of the file.

- [ ] **Step 6: Extend the AgentBridge type**

In `src/shared/types/ui.ts`, update `AgentBridge` (~line 257) and its imports:

```ts
export type AgentBridge = {
  list(): Promise<AgentListItem[]>
  save(def: AgentDefinition): Promise<AgentMutationResult>
  remove(id: string): Promise<AgentMutationResult>
}
```

Add to the agent-type import at the top of `ui.ts`: `AgentDefinition, AgentListItem, AgentMutationResult` from `./agent`.

- [ ] **Step 7: Extend the renderer api**

In `src/renderer/src/lib/api.ts`, update the agent methods:

```ts
  listAgents: (): Promise<AgentListItem[]> => window.swarm.agents.list(),
  saveAgent: (def: AgentDefinition): Promise<AgentMutationResult> => window.swarm.agents.save(def),
  removeAgent: (id: string): Promise<AgentMutationResult> => window.swarm.agents.remove(id),
```

Add `AgentListItem, AgentMutationResult` to the `@shared/types/agent` import (line 1 already imports `AgentDefinition`).

- [ ] **Step 8: Typecheck + full suite**

Run: `npm run typecheck && npm test 2>&1 | tail -4`
Expected: typecheck exits 0 (the `listAgents` return type change ripples cleanly because `AgentListItem` extends `AgentDefinition`); full suite passes. No new unit test — this task is typed plumbing verified by the compiler and the unchanged-behavior suite.

- [ ] **Step 9: Commit**

```bash
git add src/shared/types/service-ipc.ts src/service/ipc/dispatcher.ts src/service/index.ts src/main/ipc/swarm-ipc.ts src/preload/index.ts src/shared/types/ui.ts src/renderer/src/lib/api.ts
git commit -m "feat(agents): IPC write path for agent save/delete + builtin-tagged list"
```

---

### Task 3: `AgentFormSheet` component

**Files:**
- Create: `src/renderer/src/components/views/agent-form-sheet.tsx`
- Test: `src/renderer/src/components/views/agent-form-sheet.test.tsx`

**Interfaces:**
- Consumes: `AgentDefinition`, `ToolScope` from `@shared/types/agent`; Sheet/Input/Textarea/Label/NativeSelect/Button/Switch UI primitives.
- Produces: `export function AgentFormSheet(props): React.JSX.Element` where
  ```ts
  type AgentFormSheetProps = {
    open: boolean
    mode: 'create' | 'edit' | 'duplicate'
    agent?: AgentDefinition          // source for edit/duplicate; undefined for create
    agents: AgentDefinition[]        // for the parentId dropdown
    error?: string                   // message from a failed mutation
    onSubmit: (def: AgentDefinition) => void
    onOpenChange: (open: boolean) => void
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/components/views/agent-form-sheet.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type { AgentDefinition } from '@shared/types/agent'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentFormSheet } from './agent-form-sheet'

const existing: AgentDefinition = {
  id: 'pm',
  name: 'PM',
  description: 'plans',
  systemPrompt: 'be the pm',
  toolScope: 'all',
  maxIterations: 25,
}

afterEach(cleanup)

describe('AgentFormSheet', () => {
  it('create mode: assembles an AgentDefinition omitting empty optionals', () => {
    const onSubmit = vi.fn()
    render(
      <AgentFormSheet open mode="create" agents={[existing]} onSubmit={onSubmit} onOpenChange={() => {}} />
    )
    fireEvent.change(screen.getByLabelText('id'), { target: { value: 'helper' } })
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Helper' } })
    fireEvent.change(screen.getByLabelText('description'), { target: { value: 'helps' } })
    fireEvent.change(screen.getByLabelText('system prompt'), { target: { value: 'do help' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toEqual({
      id: 'helper',
      name: 'Helper',
      description: 'helps',
      systemPrompt: 'do help',
      toolScope: 'all',
      maxIterations: 25,
    })
  })

  it('edit mode: prefills fields and makes id read-only', () => {
    render(
      <AgentFormSheet open mode="edit" agent={existing} agents={[existing]} onSubmit={() => {}} onOpenChange={() => {}} />
    )
    expect(screen.getByLabelText('name')).toHaveValue('PM')
    expect(screen.getByLabelText('id')).toHaveAttribute('readonly')
  })

  it('parentId dropdown lists other agents and excludes the edited agent', () => {
    render(
      <AgentFormSheet
        open
        mode="edit"
        agent={existing}
        agents={[existing, { ...existing, id: 'eng', name: 'Eng' }]}
        onSubmit={() => {}}
        onOpenChange={() => {}}
      />
    )
    const parent = screen.getByLabelText('parent') as HTMLSelectElement
    const values = Array.from(parent.options).map((o) => o.value)
    expect(values).toContain('') // "(none)"
    expect(values).toContain('eng')
    expect(values).not.toContain('pm') // cannot parent to self
  })

  it('toggling "Team head" sets teamRole to head on submit', () => {
    const onSubmit = vi.fn()
    render(
      <AgentFormSheet open mode="create" agents={[]} onSubmit={onSubmit} onOpenChange={() => {}} />
    )
    fireEvent.change(screen.getByLabelText('id'), { target: { value: 'lead' } })
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Lead' } })
    fireEvent.change(screen.getByLabelText('description'), { target: { value: 'leads' } })
    fireEvent.change(screen.getByLabelText('system prompt'), { target: { value: 'lead it' } })
    fireEvent.change(screen.getByLabelText('team'), { target: { value: 'ui' } })
    fireEvent.click(screen.getByLabelText('Team head'))
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ team: 'ui', teamRole: 'head' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/renderer/src/components/views/agent-form-sheet.test.tsx`
Expected: FAIL — `./agent-form-sheet` does not exist.

- [ ] **Step 3: Implement `AgentFormSheet`**

Create `src/renderer/src/components/views/agent-form-sheet.tsx`:

```tsx
import { useEffect, useState } from 'react'

import type { AgentDefinition, ToolScope } from '@shared/types/agent'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

type AgentFormSheetProps = {
  open: boolean
  mode: 'create' | 'edit' | 'duplicate'
  agent?: AgentDefinition
  agents: AgentDefinition[]
  error?: string
  onSubmit: (def: AgentDefinition) => void
  onOpenChange: (open: boolean) => void
}

const SCOPES: ToolScope[] = ['peekaboo', 'web', 'fs', 'memory', 'authoring', 'all']

/** Right-side form to create / edit / duplicate an agent. Prop-driven: it owns
 *  only local field state and calls onSubmit with the assembled definition;
 *  persistence lives in the caller (useAgentMutations). */
export function AgentFormSheet({
  open,
  mode,
  agent,
  agents,
  error,
  onSubmit,
  onOpenChange,
}: AgentFormSheetProps): React.JSX.Element {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [toolScope, setToolScope] = useState<ToolScope>('all')
  const [parentId, setParentId] = useState('')
  const [team, setTeam] = useState('')
  const [teamHead, setTeamHead] = useState(false)
  const [role, setRole] = useState('')
  const [capabilities, setCapabilities] = useState('')
  const [model, setModel] = useState('')
  const [maxIterations, setMaxIterations] = useState('25')

  // Re-seed fields whenever the sheet opens for a different agent/mode.
  useEffect(() => {
    const a = agent
    setId(mode === 'duplicate' ? '' : (a?.id ?? ''))
    setName(a?.name ?? '')
    setDescription(a?.description ?? '')
    setSystemPrompt(a?.systemPrompt ?? '')
    setToolScope(a?.toolScope ?? 'all')
    setParentId(a?.parentId ?? '')
    setTeam(a?.team ?? '')
    setTeamHead(a?.teamRole === 'head')
    setRole(a?.role ?? '')
    setCapabilities((a?.capabilities ?? []).join(', '))
    setModel(a?.model ?? '')
    setMaxIterations(String(a?.maxIterations ?? 25))
  }, [agent, mode, open])

  const idReadOnly = mode === 'edit'

  const submit = (): void => {
    const caps = capabilities
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
    const def: AgentDefinition = {
      id: id.trim(),
      name: name.trim(),
      description: description.trim(),
      systemPrompt,
      toolScope,
      maxIterations: Number(maxIterations) || 25,
      ...(parentId ? { parentId } : {}),
      ...(team.trim() ? { team: team.trim() } : {}),
      ...(teamHead ? { teamRole: 'head' as const } : {}),
      ...(role.trim() ? { role: role.trim() } : {}),
      ...(caps.length ? { capabilities: caps } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    }
    onSubmit(def)
  }

  const title = mode === 'edit' ? 'Edit agent' : mode === 'duplicate' ? 'Duplicate agent' : 'New agent'

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-xl" side="right">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {error && <p className="rounded bg-destructive/10 px-3 py-2 text-destructive text-sm">{error}</p>}

          <Field label="id" htmlFor="agent-id">
            <Input id="agent-id" onChange={(e) => setId(e.target.value)} readOnly={idReadOnly} value={id} />
          </Field>
          <Field label="name" htmlFor="agent-name">
            <Input id="agent-name" onChange={(e) => setName(e.target.value)} value={name} />
          </Field>
          <Field label="description" htmlFor="agent-description">
            <Textarea
              id="agent-description"
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              value={description}
            />
          </Field>
          <Field label="system prompt" htmlFor="agent-systemPrompt">
            <Textarea
              id="agent-systemPrompt"
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={10}
              value={systemPrompt}
            />
          </Field>
          <Field label="tool scope" htmlFor="agent-toolScope">
            <NativeSelect id="agent-toolScope" onChange={(e) => setToolScope(e.target.value as ToolScope)} value={toolScope}>
              {SCOPES.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {s}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="parent" htmlFor="agent-parent">
            <NativeSelect id="agent-parent" onChange={(e) => setParentId(e.target.value)} value={parentId}>
              <NativeSelectOption value="">(none)</NativeSelectOption>
              {agents
                .filter((a) => a.id !== agent?.id)
                .map((a) => (
                  <NativeSelectOption key={a.id} value={a.id}>
                    {a.name} ({a.id})
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </Field>
          <Field label="team" htmlFor="agent-team">
            <Input id="agent-team" onChange={(e) => setTeam(e.target.value)} value={team} />
          </Field>
          <div className="flex items-center gap-2">
            <Switch aria-label="Team head" checked={teamHead} id="agent-teamHead" onCheckedChange={setTeamHead} />
            <Label htmlFor="agent-teamHead">Team head</Label>
          </div>
          <Field label="role" htmlFor="agent-role">
            <Input id="agent-role" onChange={(e) => setRole(e.target.value)} value={role} />
          </Field>
          <Field label="capabilities" htmlFor="agent-capabilities">
            <Input
              id="agent-capabilities"
              onChange={(e) => setCapabilities(e.target.value)}
              placeholder="comma, separated"
              value={capabilities}
            />
          </Field>
          <Field label="model" htmlFor="agent-model">
            <Input id="agent-model" onChange={(e) => setModel(e.target.value)} value={model} />
          </Field>
          <Field label="max iterations" htmlFor="agent-maxIterations">
            <Input
              id="agent-maxIterations"
              onChange={(e) => setMaxIterations(e.target.value)}
              type="number"
              value={maxIterations}
            />
          </Field>
        </div>

        <SheetFooter className="border-t px-4 py-3">
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button onClick={submit}>Save</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/** Label + control row; the label's text is the control's accessible name. */
function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/renderer/src/components/views/agent-form-sheet.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/views/agent-form-sheet.tsx src/renderer/src/components/views/agent-form-sheet.test.tsx
git commit -m "feat(agents): AgentFormSheet create/edit/duplicate form"
```

---

### Task 4: `useAgentMutations` + wire CRUD into `OrgTreeView`

**Files:**
- Create: `src/renderer/src/hooks/use-agent-mutations.ts`
- Modify: `src/renderer/src/components/views/org-tree-view.tsx`
- Test: `src/renderer/src/components/views/org-tree-view.test.tsx`

**Interfaces:**
- Consumes: `swarmApi.saveAgent/removeAgent` (Task 2); `AgentFormSheet` (Task 3); `AgentListItem` (Task 1).
- Produces: `useAgentMutations()` → `{ save, remove }` (async, invalidate `['agents','settings']`); `OrgTreeView` gains create/edit/duplicate/delete.

Note: `OrgTreeView`/`OrgTree`/`AgentNodeCard` currently take `AgentDefinition[]`. `AgentListItem` extends it, so the existing signatures keep compiling; the new actions read `agent.builtin`.

- [ ] **Step 1: Write the failing tests**

Append to `src/renderer/src/components/views/org-tree-view.test.tsx` a new describe block:

```tsx
describe('OrgTreeView CRUD affordances', () => {
  const li = (over: Partial<AgentDefinition> & { id: string; builtin: boolean }) => ({
    name: over.id,
    description: 'd',
    systemPrompt: 'p',
    toolScope: 'all' as const,
    maxIterations: 25,
    ...over,
  })

  it('shows Edit + Delete on a user agent and only Duplicate on a builtin', () => {
    render(<OrgTreeView agents={[li({ id: 'user', name: 'User', builtin: false }), li({ id: 'bi', name: 'BI', builtin: true })]} />)
    const userCard = screen.getByText('User').closest('li') as HTMLElement
    const biCard = screen.getByText('BI').closest('li') as HTMLElement
    expect(within(userCard).getByLabelText(/edit/i)).toBeInTheDocument()
    expect(within(userCard).getByLabelText(/delete/i)).toBeInTheDocument()
    expect(within(biCard).queryByLabelText(/delete/i)).not.toBeInTheDocument()
    expect(within(biCard).getByLabelText(/duplicate/i)).toBeInTheDocument()
  })

  it('clicking New opens the form sheet', () => {
    render(<OrgTreeView agents={[li({ id: 'user', name: 'User', builtin: false })]} />)
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }))
    expect(screen.getByText('New agent')).toBeInTheDocument()
  })
})
```

Add `import` for `fireEvent` and `within` to the test file's `@testing-library/react` import if not already present.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/renderer/src/components/views/org-tree-view.test.tsx`
Expected: FAIL — no New button / no edit-delete-duplicate controls yet.

- [ ] **Step 3: Implement `useAgentMutations`**

Create `src/renderer/src/hooks/use-agent-mutations.ts`:

```ts
import { useQueryClient } from '@tanstack/react-query'

import type { AgentDefinition, AgentMutationResult } from '@shared/types/agent'
import { swarmApi } from '@/lib/api'

/** Create/update + delete agents, refreshing the Agents query on success. */
export function useAgentMutations(): {
  save: (def: AgentDefinition) => Promise<AgentMutationResult>
  remove: (id: string) => Promise<AgentMutationResult>
} {
  const queryClient = useQueryClient()
  const refresh = (): void => void queryClient.invalidateQueries({ queryKey: ['agents', 'settings'] })
  return {
    save: async (def) => {
      const r = await swarmApi.saveAgent(def)
      if (r.ok) refresh()
      return r
    },
    remove: async (id) => {
      const r = await swarmApi.removeAgent(id)
      if (r.ok) refresh()
      return r
    },
  }
}
```

- [ ] **Step 4: Wire CRUD into `OrgTreeView`**

Edit `src/renderer/src/components/views/org-tree-view.tsx`:

Update imports at the top:

```tsx
import { useState } from 'react'

import { type OrgNode, buildOrgForest } from '@shared/agents/org-tree'
import type { AgentDefinition, AgentListItem } from '@shared/types/agent'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useAgentMutations } from '@/hooks/use-agent-mutations'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { AgentDetail } from './agent-detail'
import { AgentFormSheet } from './agent-form-sheet'
```

Extend `AgentNodeCard` to render actions. Replace the existing `AgentNodeCard` with:

```tsx
function AgentNodeCard({
  agent,
  isActive,
  onClick,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  agent: AgentListItem
  isActive: boolean
  onClick: () => void
  onEdit: (a: AgentListItem) => void
  onDuplicate: (a: AgentListItem) => void
  onDelete: (a: AgentListItem) => void
}): React.JSX.Element {
  const caps = agent.capabilities ?? []
  const shown = caps.slice(0, MAX_CAPS)
  const extra = caps.length - shown.length
  return (
    <div
      className={cn(
        'group flex items-start gap-2 rounded-lg border bg-card p-2.5 transition-colors hover:bg-accent',
        isActive && 'border-primary ring-1 ring-primary'
      )}
    >
      <button className="min-w-0 flex-1 text-left" onClick={onClick} type="button">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-sm">{agent.name}</span>
          <span className="truncate font-mono text-muted-foreground text-xs">{agent.role ?? agent.id}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {agent.team && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary text-xs">{agent.team}</span>
          )}
          <span className="text-muted-foreground text-xs">scope: {agent.toolScope}</span>
          {shown.map((c) => (
            <span key={c} className="rounded bg-secondary px-1 py-0.5 text-secondary-foreground text-[10px]">
              {c}
            </span>
          ))}
          {extra > 0 && <span className="text-muted-foreground text-[10px]">+{extra} more</span>}
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {agent.builtin ? (
          <Button aria-label={`Duplicate ${agent.name}`} onClick={() => onDuplicate(agent)} size="icon" variant="ghost">
            <Copy className="size-4" />
          </Button>
        ) : (
          <>
            <Button aria-label={`Edit ${agent.name}`} onClick={() => onEdit(agent)} size="icon" variant="ghost">
              <Pencil className="size-4" />
            </Button>
            <Button
              aria-label={`Delete ${agent.name}`}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => onDelete(agent)}
              size="icon"
              variant="ghost"
            >
              <Trash2 className="size-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
```

Thread the action callbacks through `OrgTreeNode` and `OrgTree` (they currently take `{ node, expanded, onToggle }`). Add `onEdit`, `onDuplicate`, `onDelete` to both components' props and pass them down to `AgentNodeCard` and recursive `OrgTreeNode` children. Change their `agents`/`node` types to use `AgentListItem` (the forest's `agent` is now `AgentListItem` since `OrgTree` receives `AgentListItem[]`).

Replace `OrgTreeView` with the stateful CRUD container:

```tsx
type SheetState =
  | { open: false }
  | { open: true; mode: 'create' | 'edit' | 'duplicate'; agent?: AgentListItem }

export function OrgTreeView({ agents }: { agents: AgentListItem[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [sheet, setSheet] = useState<SheetState>({ open: false })
  const [pendingDelete, setPendingDelete] = useState<AgentListItem | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const { save, remove } = useAgentMutations()

  const toggle = (id: string): void => setExpanded((prev) => (prev === id ? null : id))
  const selected = expanded ? agents.find((a) => a.id === expanded) : undefined

  const onSubmit = async (def: AgentDefinition): Promise<void> => {
    const r = await save(def)
    if (r.ok) {
      setSheet({ open: false })
      setError(undefined)
    } else {
      setError(r.message)
      toast.error(r.message)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const r = await remove(pendingDelete.id)
    if (!r.ok) toast.error(r.message)
    setPendingDelete(null)
  }

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Button className="gap-1.5" onClick={() => setSheet({ open: true, mode: 'create' })}>
          <Plus className="size-4" />
          New agent
        </Button>
      </div>

      <OrgTree
        agents={agents}
        expanded={expanded}
        onToggle={toggle}
        onEdit={(a) => setSheet({ open: true, mode: 'edit', agent: a })}
        onDuplicate={(a) => setSheet({ open: true, mode: 'duplicate', agent: a })}
        onDelete={(a) => setPendingDelete(a)}
      />
      {selected && <AgentDetail agent={selected} />}

      <AgentFormSheet
        agent={sheet.open ? sheet.agent : undefined}
        agents={agents}
        error={error}
        mode={sheet.open ? sheet.mode : 'create'}
        onOpenChange={(o) => {
          if (!o) {
            setSheet({ open: false })
            setError(undefined)
          }
        }}
        onSubmit={onSubmit}
        open={sheet.open}
      />

      <AlertDialog onOpenChange={(o) => !o && setPendingDelete(null)} open={pendingDelete !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete agent “{pendingDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>This removes its AGENT.md from disk. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
```

(`OrgTree` and `OrgTreeNode` get the three new callback props in their type signatures and forward them; the recursive `OrgTreeNode` passes them to its child `OrgTreeNode`s and to `AgentNodeCard`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/renderer/src/components/views/org-tree-view.test.tsx`
Expected: PASS (prior OrgTree tests + the 2 new CRUD-affordance tests). Note: the prior tests build agents without a `builtin` field; that is fine — `agent.builtin` is simply falsy, so those nodes render Edit/Delete, which the prior tests do not assert against.

- [ ] **Step 6: Typecheck + full view suite**

Run: `npm run typecheck && npm test -- src/renderer/src/components/views 2>&1 | tail -6`
Expected: typecheck 0; all view tests pass.

- [ ] **Step 7: Verify the running app (manual, best-effort)**

Use the `run-desktop` skill to open Settings → Agents and confirm: a New agent button; hovering a user agent shows Edit + Delete; a built-in shows only Duplicate; creating an agent makes it appear live; deleting asks for confirmation. If the headless launch is Keychain-blocked, note it and rely on the RTL + typecheck evidence.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/hooks/use-agent-mutations.ts src/renderer/src/components/views/org-tree-view.tsx src/renderer/src/components/views/org-tree-view.test.tsx
git commit -m "feat(agents): create/edit/duplicate/delete agents from the org tree"
```

---

## Self-Review

**Spec coverage:**
- IPC write path mirroring skills (spec §Architecture) → Task 2 ✓
- `AgentListItem` builtin tagging, schema unchanged (spec §Data model) → Task 1 (type) + Task 2 (tagging) ✓
- Reuse store save/remove + Spec 1 validation (spec §Decision) → Tasks 1–2 (no reimplementation) ✓
- `AgentFormSheet` right-side Sheet, 4 field groups, parentId dropdown, id read-only on edit (spec §Form) → Task 3 ✓
- Builtins read-only + Duplicate; user edit/delete; New button (spec §Renderer) → Task 4 ✓
- Validation surfacing (toast + inline error) (spec §Form) → Task 4 (`onSubmit`/`error`) + Task 3 (`error` prop) ✓
- Tests: store isBuiltin, form round-trip/prefill/dropdown, OrgTreeView affordances (spec §Testing) → Tasks 1,3,4 ✓
- Backward compat: AgentListItem extends AgentDefinition; store.list() unchanged (spec §Backward compatibility) → Tasks 1–2 notes ✓

**Placeholder scan:** none — every code step has full code; the only prose-only step (Task 4 Step 4 "thread callbacks through OrgTreeNode/OrgTree") describes a mechanical prop-forwarding change whose target component bodies are shown in the same task.

**Type consistency:** `AgentMutationResult`/`AgentListItem` from `@shared/types/agent` used identically in Tasks 1–4. `swarmApi.saveAgent/removeAgent` signatures match between Task 2 (definition) and Task 4 (`useAgentMutations` usage). `AgentFormSheetProps` matches between Task 3 (definition) and Task 4 (usage: `open`/`mode`/`agent`/`agents`/`error`/`onSubmit`/`onOpenChange`). `useAgentMutations` returns `{ save, remove }` consumed by `OrgTreeView`.
