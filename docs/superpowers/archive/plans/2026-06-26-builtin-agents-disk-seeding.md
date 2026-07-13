# Built-in Agents: Disk Seeding + CEO Resilience + Detail Drawer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the agent definitions as on-disk seed data the user owns, make company runs self-heal a missing critical role, and show agent detail in a right-side read-only drawer.

**Architecture:** Move the agent definitions to `src/shared/constants/agents.ts` (exported `defaultAgents`). The `AgentStore` becomes pure-disk (no in-code overlay); the service seeds the defaults to disk on first init. `startCompany` re-seeds any deleted company-critical role before kickoff, and `spawnResident` logs a warn when a def can't be resolved. The Agents settings tab renders the selected agent in a read-only `Sheet`.

**Tech Stack:** TypeScript, Electron (utilityProcess service), React + Radix `Sheet`, Vitest, Zod, Pino.

## Global Constraints

- Reply language is Chinese; **code comments and commit messages in English** (CLAUDE.md §0).
- Run tests with `npm test` (Electron-as-node) — never bare `npx vitest`, never `pnpm rebuild better-sqlite3`. Single file: `npm test -- <path>`.
- Typecheck: `npm run typecheck`. Scoped format: `npx biome check --write <file>` (never `npm run check` — it reformats the whole repo).
- Every business path gets structured logs (CLAUDE.md §5): entries at `info`, every `catch` at `error`, branch surprises (fallbacks, "not found" recoveries) at `warn`, structured first arg `log.xxx({ msg, ... })`.
- Surgical changes only (CLAUDE.md §3): every changed line traces to this plan.
- `COMPANY_ROLES` (source of truth, `manager.ts:35`): `['ceo', 'pm', 'engineer', 'reviewer', 'training-head', 'training-author']`.

---

## File Structure

- `src/shared/constants/agents.ts` — **new** (moved from `src/shared/agents/builtins.ts`); exports `defaultAgents` + `DEFAULT_AGENT_DEF`.
- `src/shared/constants/agents.test.ts` — **moved** from `src/shared/agents/builtins.test.ts`.
- `src/shared/constants/agents.company.test.ts` — **moved** from `src/shared/agents/builtins.company.test.ts`.
- `src/service/agents/store.ts` — pure-disk store; add `seedDefaultAgents`; drop `builtins` overlay + `isBuiltin`.
- `src/service/agents/store.test.ts` — drop overlay/`isBuiltin` tests; add seed + pure-disk tests.
- `src/service/index.ts` — seed-on-init; `createAgentStore({ dir })`; `listAgents` drops `.builtin`.
- `src/shared/types/agent.ts` — drop `builtin` from `AgentListItem`.
- `src/service/session/manager.ts` — `startCompany` self-heal; `spawnResident` warn; import from new path.
- `src/service/e2e/company.startup.test.ts` — import rename + new self-heal test.
- `src/service/e2e/company.e2e.test.ts`, `src/service/e2e/multi-team-company.e2e.test.ts`, `scripts/smoke-company.ts` — import rename.
- `src/renderer/src/components/views/org-tree-view.tsx` — read-only detail `Sheet`; remove builtin gating.
- `src/renderer/src/components/views/org-tree-view.test.tsx` — update detail + CRUD-affordance tests.

---

## Task 1: Move definitions to `src/shared/constants/agents.ts` (export `defaultAgents`)

Mechanical rename + import update. Behavior is identical at the end of this task (`index.ts` still passes `builtins: defaultAgents`).

**Files:**
- Move: `src/shared/agents/builtins.ts` → `src/shared/constants/agents.ts`
- Move: `src/shared/agents/builtins.test.ts` → `src/shared/constants/agents.test.ts`
- Move: `src/shared/agents/builtins.company.test.ts` → `src/shared/constants/agents.company.test.ts`
- Modify: `src/service/index.ts`, `src/service/session/manager.ts`, `src/service/e2e/company.startup.test.ts`, `src/service/e2e/company.e2e.test.ts`, `src/service/e2e/multi-team-company.e2e.test.ts`, `scripts/smoke-company.ts`

**Interfaces:**
- Produces: `export const defaultAgents: AgentDefinition[]` and `export const DEFAULT_AGENT_DEF: AgentDefinition` from `@shared/constants/agents`.

- [ ] **Step 1: Move the files with git**

```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents
mkdir -p src/shared/constants
git mv src/shared/agents/builtins.ts src/shared/constants/agents.ts
git mv src/shared/agents/builtins.test.ts src/shared/constants/agents.test.ts
git mv src/shared/agents/builtins.company.test.ts src/shared/constants/agents.company.test.ts
```

- [ ] **Step 2: Rename the export `builtinAgents` → `defaultAgents`**

In `src/shared/constants/agents.ts`, change the array declaration and the `DEFAULT_AGENT_DEF` line:

```typescript
export const defaultAgents: AgentDefinition[] = [
  // ...unchanged entries...
]

/** The default agent type — single source of truth for the fallback definition. */
export const DEFAULT_AGENT_DEF: AgentDefinition = defaultAgents[0]
```

- [ ] **Step 3: Update every importer to the new path + name**

```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents
# path: @shared/agents/builtins -> @shared/constants/agents
grep -rl "@shared/agents/builtins" src scripts | xargs sed -i '' "s#@shared/agents/builtins#@shared/constants/agents#g"
# identifier: builtinAgents -> defaultAgents (import sites + the two moved test files' usages)
grep -rl "builtinAgents" src scripts | xargs sed -i '' "s#builtinAgents#defaultAgents#g"
```

Then open the two moved test files and confirm any `describe('builtins'…)` strings still read sensibly (cosmetic; leave as-is if clear). `DEFAULT_AGENT_DEF` keeps its name everywhere.

- [ ] **Step 4: Typecheck + full test run**

Run: `npm run typecheck && npm test`
Expected: PASS. No remaining references to `@shared/agents/builtins` or `builtinAgents`:

```bash
grep -rn "@shared/agents/builtins\|builtinAgents" src scripts   # expect: no matches
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(agents): move builtins to shared/constants/agents.ts, export defaultAgents"
```

---

## Task 2: Pure-disk store + `seedDefaultAgents` + service wiring + drop `builtin` flag

The store stops overlaying in-code definitions. The service seeds defaults to disk only when the agents dir is empty. The `AgentListItem.builtin` flag is removed; the org tree shows Edit/Duplicate/Delete for every agent (the read-only drawer comes in Task 4).

**Files:**
- Modify: `src/service/agents/store.ts`
- Test: `src/service/agents/store.test.ts`
- Modify: `src/service/index.ts:56`, `src/service/index.ts:132`
- Modify: `src/shared/types/agent.ts:59`
- Modify: `src/renderer/src/components/views/org-tree-view.tsx:75-95`
- Test: `src/renderer/src/components/views/org-tree-view.test.tsx:138-160`

**Interfaces:**
- Consumes: `defaultAgents`, `serializeAgent` (from Task 1 / store).
- Produces: `export function seedDefaultAgents(dir: string, defs: AgentDefinition[]): boolean` — writes one `<dir>/<id>/AGENT.md` per def when the dir has no agents yet; returns `true` if it seeded, `false` if already initialized. `createAgentStore(opts: { dir: string }): AgentStore` (no `builtins`). `AgentStore` no longer has `isBuiltin`.

- [ ] **Step 1: Write the failing store tests**

In `src/service/agents/store.test.ts`: (a) delete the three `builtins`-overlay tests (`'always lists and resolves built-in agents'`, `'cannot remove a built-in (no on-disk folder)'`, `'a user agent of the same id overrides its built-in'`) and the two `isBuiltin` tests, plus the `const builtin = def({...})` line. (b) Add a new `seedDefaultAgents` describe block and import it:

```typescript
import { createAgentStore, parseAgent, seedDefaultAgents, serializeAgent } from './store'
```

```typescript
describe('seedDefaultAgents', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarm-agents-seed-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes one AGENT.md per def into an empty dir and returns true', () => {
    const seeded = seedDefaultAgents(dir, [def({ id: 'a' }), def({ id: 'b' })])
    expect(seeded).toBe(true)
    expect(createAgentStore({ dir }).list().map((x) => x.id).sort()).toEqual(['a', 'b'])
  })

  it('is a no-op when the dir already has an agent (deletions persist)', () => {
    createAgentStore({ dir }).save(def({ id: 'kept' }))
    const seeded = seedDefaultAgents(dir, [def({ id: 'a' })])
    expect(seeded).toBe(false)
    expect(createAgentStore({ dir }).list().map((x) => x.id)).toEqual(['kept'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/service/agents/store.test.ts`
Expected: FAIL — `seedDefaultAgents` is not exported.

- [ ] **Step 3: Make the store pure-disk + add `seedDefaultAgents`**

In `src/service/agents/store.ts`:

Remove `isBuiltin` from the `AgentStore` type (lines 19-20) and the `watch` doc stays. Change `createAgentStore` to drop the overlay:

```typescript
export function createAgentStore(opts: { dir: string }): AgentStore {
  const { dir } = opts
  let agents: AgentDefinition[] = []
```

Delete the `merged()` helper (old lines 89-94). In `save`, replace `merged()` with `agents` in the parentId map and the return:

```typescript
      const byId = new Map(agents.map((a) => [a.id, a]))
      byId.set(id, parsed.data)
```
```typescript
    reload()
    return { ok: true, agents }
```

In `remove`, replace the return `merged()` with `agents`:

```typescript
    reload()
    return { ok: true, agents }
```

Delete the `isBuiltin` const (old lines 155-156). Update the returned object:

```typescript
  return {
    list: () => agents,
    get: (id) => agents.find((a) => a.id === id),
    reload,
    save,
    remove,
    watch,
  }
```

Add the exported seed helper (after `serializeAgent`, before `createAgentStore`):

```typescript
/**
 * Seed the default agents to disk, but only when `dir` has no agents yet (fresh
 * init). Returns true if it seeded, false if the dir was already initialized —
 * so a user's later deletion of a default is not resurrected on restart.
 */
export function seedDefaultAgents(dir: string, defs: AgentDefinition[]): boolean {
  const alreadyInitialized =
    existsSync(dir) &&
    readdirSync(dir, { withFileTypes: true }).some(
      (e) => e.isDirectory() && existsSync(join(dir, e.name, 'AGENT.md'))
    )
  if (alreadyInitialized) return false
  for (const def of defs) {
    const folder = join(dir, def.id)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'AGENT.md'), serializeAgent(def))
  }
  log.info({ msg: 'seeded default agents to disk', dir, count: defs.length })
  return true
}
```

- [ ] **Step 4: Run the store tests to verify they pass**

Run: `npm test -- src/service/agents/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire seeding + drop overlay in the service entry**

In `src/service/index.ts`: add `seedDefaultAgents` to the store import and `defaultAgents` is already imported (Task 1). Replace the store construction (line 56) and the `listAgents` annotation (line 132):

```typescript
import { createAgentStore, seedDefaultAgents } from './agents/store'
```
```typescript
// Seed the shipped defaults to disk on first init so they are real, editable
// AGENT.md files the user owns; a no-op once the dir has agents.
seedDefaultAgents(agentsPath, defaultAgents)
const agentStore = createAgentStore({ dir: agentsPath })
```
```typescript
  listAgents: () => agentStore.list(),
```

- [ ] **Step 6: Drop the `builtin` flag from the shared type**

In `src/shared/types/agent.ts:59`:

```typescript
/** An agent as listed for the UI. (All agents are real on-disk files.) */
export type AgentListItem = AgentDefinition
```

- [ ] **Step 7: Show CRUD affordances for every agent in the org tree**

In `src/renderer/src/components/views/org-tree-view.tsx`, replace the `agent.builtin ? (Duplicate-only) : (Edit/Delete)` block (lines 76-95) with the unconditional action row (keep Duplicate too):

```tsx
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Button aria-label={`Edit ${agent.name}`} onClick={() => onEdit(agent)} size="icon" variant="ghost">
          <Pencil className="size-4" />
        </Button>
        <Button aria-label={`Duplicate ${agent.name}`} onClick={() => onDuplicate(agent)} size="icon" variant="ghost">
          <Copy className="size-4" />
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
      </div>
```

- [ ] **Step 8: Update the renderer tests for the dropped flag**

In `src/renderer/src/components/views/org-tree-view.test.tsx`, the `OrgTreeView CRUD affordances` block (lines ~138-160): change the `li` helper signature to drop `builtin`, and rewrite the first test to assert Edit + Delete show for every agent:

```tsx
describe('OrgTreeView CRUD affordances', () => {
  const li = (over: Partial<AgentDefinition> & { id: string }) => ({
    name: over.id,
    description: 'd',
    systemPrompt: 'p',
    toolScope: 'all' as const,
    maxIterations: 25,
    ...over,
  })

  it('shows Edit + Duplicate + Delete on every agent', () => {
    render(<OrgTreeView agents={[li({ id: 'user', name: 'User' }), li({ id: 'bi', name: 'BI' })]} />)
    for (const name of ['User', 'BI']) {
      const card = screen.getByText(name).closest('li') as HTMLElement
      expect(within(card).getByLabelText(/edit/i)).toBeInTheDocument()
      expect(within(card).getByLabelText(/duplicate/i)).toBeInTheDocument()
      expect(within(card).getByLabelText(/delete/i)).toBeInTheDocument()
    }
  })

  it('clicking New opens the form sheet', () => {
    render(<OrgTreeView agents={[li({ id: 'user', name: 'User' })]} />)
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }))
    expect(screen.getByText('New agent')).toBeInTheDocument()
  })
})
```

- [ ] **Step 9: Typecheck + full test run**

Run: `npm run typecheck && npm test`
Expected: PASS. Then confirm no stray `isBuiltin`/`.builtin` references remain:

```bash
grep -rn "isBuiltin\|\.builtin\b" src   # expect: no matches
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(agents): pure-disk store + seed defaults on init; drop builtin overlay"
```

---

## Task 3: CEO resilience — `startCompany` self-heal + `spawnResident` warn

A deleted company-critical role is re-seeded from `defaultAgents` before the CEO kickoff, and an unresolved def is logged at `warn` instead of silently degrading to the default agent.

**Files:**
- Modify: `src/service/session/manager.ts:2` (import), `:295` (spawnResident warn), `:822-830` (startCompany)
- Test: `src/service/e2e/company.startup.test.ts`

**Interfaces:**
- Consumes: `defaultAgents`, `DEFAULT_AGENT_DEF` (from `@shared/constants/agents`); `cfg.agentStore.get`, `cfg.agentStore.save` (existing `AgentStore` API).

- [ ] **Step 1: Write the failing self-heal test**

In `src/service/e2e/company.startup.test.ts`, add a test. It uses a mock store that reports `ceo` as deleted (returns `undefined`) until `save` is called, and records saves:

```typescript
it('re-seeds a deleted company-critical role before kicking off the CEO', async () => {
  const present = new Map(defaultAgents.map((a) => [a.id, a]))
  present.delete('ceo') // simulate the user having deleted the CEO
  const saved: string[] = []
  const healingStore = {
    get: (id: string) => present.get(id),
    list: () => [...present.values()],
    save: (def: any) => {
      present.set(def.id, def)
      saved.push(def.id)
      return { ok: true, agents: [...present.values()] }
    },
  }
  const store = createConversationStore(':memory:')
  const mgr = createSessionManager({
    store,
    broadcaster: { broadcast: () => {} },
    maxConcurrent: 4,
    getProvider: () => fakeProvider,
    agentStore: healingStore as any,
  })
  const { sessionId } = mgr.createSession(fakeProvider)

  const result = await mgr.startCompany(sessionId, 'build a thing')

  expect(saved).toContain('ceo')        // the deleted role was re-seeded
  expect(result).toEqual({ reply: 'FINAL: shipped' }) // CEO ran as the real CEO
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/service/e2e/company.startup.test.ts`
Expected: FAIL — `saved` does not contain `'ceo'` (no self-heal yet).

- [ ] **Step 3: Add the self-heal loop to `startCompany`**

In `src/service/session/manager.ts`, line 2 import already points to the new path (Task 1); extend it to also import `defaultAgents`:

```typescript
import { DEFAULT_AGENT_DEF, defaultAgents } from '@shared/constants/agents'
```

Replace `startCompany` (lines 822-830) with:

```typescript
    async startCompany(sessionId, goal) {
      // Seed the fixed roster as named, addressable actors, then rpc-kick the
      // CEO; its reply is the result of the whole run.
      log.info({ msg: 'company started', sessionId, goalLen: goal.length })
      // Self-heal: re-seed any company-critical role the user deleted so
      // find_agents discovery and the 'ceo' kickoff resolve to the real defs.
      for (const roleId of COMPANY_ROLES) {
        if (cfg.agentStore?.get(roleId)) continue
        const def = defaultAgents.find((d) => d.id === roleId)
        if (!def) continue
        const r = cfg.agentStore?.save(def)
        if (r?.ok) log.warn({ msg: 'company role re-seeded (was missing)', sessionId, roleId })
        else log.error({ msg: 'company role re-seed failed', sessionId, roleId, err: r && !r.ok ? r.message : 'no agent store' })
      }
      for (const roleId of COMPANY_ROLES) {
        ensureActor(sessionId, roleId, roleId)
      }
      return sendMessage(sessionId, null, 'ceo', goal, 'rpc')
    },
```

- [ ] **Step 4: Add the warn to `spawnResident`**

In `src/service/session/manager.ts`, replace line 295:

```typescript
    const resolved = cfg.agentStore?.get(actor.agentDefId)
    if (!resolved) {
      log.warn({
        msg: 'agent def not found; falling back to default agent',
        sessionId,
        address: actor.address,
        agentDefId: actor.agentDefId,
      })
    }
    const def = resolved ?? DEFAULT_AGENT_DEF
```

- [ ] **Step 5: Run the self-heal test to verify it passes**

Run: `npm test -- src/service/e2e/company.startup.test.ts`
Expected: PASS (both the existing roster test and the new self-heal test).

- [ ] **Step 6: Full test run**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "fix(agents): self-heal deleted company roles on startCompany; warn on def fallback"
```

---

## Task 4: Agent detail as a right-side read-only drawer

Replace the inline detail (rendered below the org tree) with a read-only `Sheet` that slides in from the right when an agent is selected, consistent with the create/edit sheet.

**Files:**
- Modify: `src/renderer/src/components/views/org-tree-view.tsx` (imports + lines 252-303 region)
- Test: `src/renderer/src/components/views/org-tree-view.test.tsx:88-103`

**Interfaces:**
- Consumes: `Sheet, SheetContent, SheetHeader, SheetTitle` (`@/components/ui/sheet`); `AgentDetail` (`./agent-detail`); `DelegationLinks` (`./delegation-links`).
- Produces: clicking an agent opens the detail sheet (`open = expanded !== null`); closing clears `expanded`.

- [ ] **Step 1: Update the detail test to assert the drawer**

In `src/renderer/src/components/views/org-tree-view.test.tsx`, the `OrgTreeView` test `'shows the selected agent detail on click and hides it on a second click'` (lines ~88-103) keeps the same behavioral assertions (prompt text appears after click, gone after the sheet closes). Replace its body to also assert a dialog/sheet role is present when open:

```tsx
  it('opens the detail drawer on click and closes it on a second click', () => {
    render(<OrgTreeView agents={[a({ id: 'pm', name: 'PM' })]} />)
    const card = (): HTMLElement => screen.getByRole('button', { name: /^PM/ })
    expect(screen.queryByText('prompt-pm')).not.toBeInTheDocument()
    fireEvent.click(card())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('prompt-pm')).toBeInTheDocument()
    fireEvent.click(card())
    expect(screen.queryByText('prompt-pm')).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/renderer/src/components/views/org-tree-view.test.tsx`
Expected: FAIL — no `dialog` role (detail is still inline, not a Sheet).

- [ ] **Step 3: Import the Sheet primitives**

In `src/renderer/src/components/views/org-tree-view.tsx`, add to the imports:

```tsx
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
```

- [ ] **Step 4: Replace inline detail with the read-only Sheet**

In `OrgTreeView`, replace the inline render block (current lines 270-273):

```tsx
      {selected && <AgentDetail agent={selected} />}
      {selected && (
        <DelegationLinks agentId={selected.id} agents={agents} edges={edges} onSelect={(id) => setExpanded(id)} />
      )}
```

with a right-side sheet driven by `expanded`:

```tsx
      <Sheet open={selected !== undefined} onOpenChange={(o) => !o && setExpanded(null)}>
        <SheetContent side="right" className="overflow-y-auto sm:max-w-md">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.name}</SheetTitle>
              </SheetHeader>
              <div className="px-4 pb-4">
                <AgentDetail agent={selected} />
                <DelegationLinks
                  agentId={selected.id}
                  agents={agents}
                  edges={edges}
                  onSelect={(id) => setExpanded(id)}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
```

(`selected` is `expanded ? agents.find((a) => a.id === expanded) : undefined`, already defined at line 232. The delegation-edge highlight keyed off `expanded` is unchanged.)

- [ ] **Step 5: Run the detail test to verify it passes**

Run: `npm test -- src/renderer/src/components/views/org-tree-view.test.tsx`
Expected: PASS (detail + delegation-highlight + CRUD tests).

- [ ] **Step 6: Typecheck + full test run + scoped format**

Run: `npm run typecheck && npm test`
Expected: PASS.
Run: `npx biome check --write src/renderer/src/components/views/org-tree-view.tsx`

- [ ] **Step 7: Verify in the running app**

Use the `run-desktop` skill to launch the app, open Settings → Agents, click an agent, and confirm the detail slides in from the right as a read-only drawer (name, id, description, system prompt, delegation links) with no Edit/Delete buttons inside it; the tree-node hover row still has Edit/Duplicate/Delete. Take a screenshot.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(agents): show agent detail in a right-side read-only drawer"
```

---

## Self-Review

**Spec coverage:**
- Constant source `constants/agents.ts` + `defaultAgents` → Task 1. ✓
- Seed-on-init (empty-dir only) → Task 2 (`seedDefaultAgents` + index wiring). ✓
- Pure-disk store, drop overlay/`isBuiltin`/`builtin` flag → Task 2. ✓
- CEO self-heal at company start + `spawnResident` warn → Task 3. ✓
- Read-only detail drawer → Task 4. ✓
- Testing (store, seed, self-heal, warn, drawer, renamed imports) → covered across Tasks 1-4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows the actual code. ✓

**Type consistency:** `defaultAgents` / `DEFAULT_AGENT_DEF` / `seedDefaultAgents(dir, defs): boolean` / `createAgentStore({ dir })` / `AgentListItem = AgentDefinition` used consistently across tasks. `cfg.agentStore.save` returns `AgentMutationResult` (`{ ok: true; agents } | { ok: false; code; message }`) — Task 3's `r && !r.ok ? r.message` matches. ✓

**Notes:** `manager.ts:486` and `:710` keep their `?? DEFAULT_AGENT_DEF` fallbacks unchanged (out of scope — the spec scopes the warn to `spawnResident`). The skills store is untouched.
