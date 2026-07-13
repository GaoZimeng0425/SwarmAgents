# Decommission `ask_user` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fully remove the blocking `ask_user` tool and its entire human-in-the-loop channel (askRegistry, `task.ask` event, `respondAsk` IPC, AskPanel), leaving the non-blocking `ui.render_ui` tool (`type: 'choice'`) as the sole way an agent surfaces a decision to the user.

**Architecture:** This is a pure removal across all layers — service tool + blocking registry, shared event/IPC types, the main-process IPC bridge, and the renderer UI/store. Because the change lands as one branch, the slicing optimizes for each task leaving the repo type-clean and test-green, not for runtime correctness between tasks. Three tasks by layer: (1) backend tool + ask channel, (2) shared `task.ask` event + renderer event handling, (3) renderer UI components + `respondAsk` IPC chain. The decision-prompt capability `ask_user` provided is already covered by `render_ui`'s `choice` renderer (verified live in the prior plan: clicking an option sends a new user turn).

**Tech Stack:** TypeScript, Electron (main/preload/renderer), React, Zustand, TanStack Query, `@earendil-works/pi-agent-core`, Vitest (run via `npm test`).

## Global Constraints

- Reply to the user in Chinese; **code comments and commit messages in English only**.
- Run tests with `npm test` (Electron node ABI) — **never** `npx vitest`, never `pnpm rebuild better-sqlite3`.
- Type-check with `npm run typecheck` (runs `typecheck:node` + `typecheck:web`); a single project via `npx tsc --noEmit -p tsconfig.node.json --composite false` or `-p tsconfig.web.json`.
- Scoped lint only: `npx biome check --write <file>` — never `pnpm check`/`format`.
- This is a DELETION plan: the regression gate for each task is **type-clean + tests green + zero dangling references** (a `grep` step proves no orphaned symbol remains). Do not introduce new behavior.
- Do NOT touch `ui.render_ui` behavior, the `ui-renderers` registry, or `task-segments.ts` — except the one `render_ui` description/comment edit explicitly specified in Task 1.
- Do NOT delete the `awaiting_user` TaskStatus — it is still used by `task.permission_request`.
- Leave the archived spec `docs/superpowers/archive/specs/2026-06-16-transcript-composer-ux-design.md` untouched (historical record).

---

### Task 1: Remove the `ask_user` tool and the backend ask channel

**Files:**
- Delete: `src/service/tools/ask.ts`
- Delete: `src/service/ask-registry.ts`
- Delete: `src/service/ask-registry.test.ts`
- Modify: `src/service/tools/builtins.ts` (remove import line 6, registration line 59)
- Modify: `src/service/tools/builtins.test.ts` (remove `'agent.ask_user'` line 38)
- Modify: `src/service/tools/registry.ts` (remove `askUser` from `ToolRunContext`, lines 30-35)
- Modify: `src/service/agent-runner.ts` (remove AskRegistry import line 16, dep field line 96, ctx wiring line 288)
- Modify: `src/service/session-manager.ts` (remove ask import line 15, `Session.askRegistry` line 30, `resolveAsk` interface line 56, `askRegistry:` runner args lines 208 & 309, `createAskRegistry` lines 235 & 249/254, `resolveAsk` impl lines 353-355, `cancelAll` call line 361)
- Modify: `src/service/dispatcher.ts` (remove `respondAsk` case lines 83-87)
- Modify: `src/service/tools/render-ui.ts` (description absorbs the decision use case; drop the dangling `ask_user` comment reference)
- Modify (remove `askUser: async () => ''` mock line): `src/service/tools/fs.test.ts:15`, `memory.test.ts:16`, `plan.test.ts:12`, `shell.test.ts:12`, `web.test.ts:20`, `registry.test.ts:29`, `cron.test.ts:13`, `render-ui.test.ts:16`

**Interfaces:**
- Produces: `ToolRunContext` (in `registry.ts`) no longer has an `askUser` member. `SessionManager` no longer has `resolveAsk`. The `Session` type no longer has `askRegistry`. `AgentRunnerDeps` no longer has `askRegistry`. The dispatcher no longer handles the `'respondAsk'` method (the method name string is removed from the shared union in Task 3).
- Consumes: nothing new.

- [ ] **Step 1: Delete the three ask-channel files**

```bash
git rm src/service/tools/ask.ts src/service/ask-registry.ts src/service/ask-registry.test.ts
```

- [ ] **Step 2: Unregister the tool in `builtins.ts`**

Remove the import (line 6): `import { askUserSpec } from './ask'`
Remove the registration (line 59): `  registry.register(askUserSpec())`
Leave `renderUiSpec` import (line 13) and registration (line 60) intact.

- [ ] **Step 3: Drop `'agent.ask_user'` from the builtins registration test**

In `src/service/tools/builtins.test.ts`, delete the line (38):

```ts
      'agent.ask_user',
```

Leave `'agent.spawn_sub_agent'`, `'agent.update_plan'`, and `'ui.render_ui'` in the expected list.

- [ ] **Step 4: Remove `askUser` from `ToolRunContext`**

In `src/service/tools/registry.ts`, delete the block (lines 30-35):

```ts
  /** Ask the human a question with clickable options; resolves with the chosen answer text. */
  askUser: (args: {
    question: string
    options: { label: string; value?: string }[]
    mode: 'single' | 'multi'
  }) => Promise<string>
```

(The closing `}` of the `ToolRunContext` interface remains.)

- [ ] **Step 5: Remove ask wiring from `agent-runner.ts`**

Delete the import (line 16): `import type { AskRegistry } from './ask-registry'`
Delete the dep field (line 96): `  askRegistry: AskRegistry`
Delete the ctx wiring (line 288): `          askUser: (args) => deps.askRegistry.request({ taskId: task.id, ...args }),`

After this, the `runCtx` object literal ends at `requestPermission: () => Promise.resolve('grant' as const),` followed by its closing `}`.

- [ ] **Step 6: Remove ask wiring from `session-manager.ts`**

Delete the import (line 15): `import { type AskRegistry, createAskRegistry } from './ask-registry'`
Delete the `Session` field (line 30): `  askRegistry: AskRegistry`
Delete the `SessionManager` interface method (line 56): `  resolveAsk(sessionId: string, askId: string, answer: string): void`
Delete the runner arg in the spawn-child runner (line 208): `          askRegistry: session.askRegistry,`
Delete the runner arg in the main-task runner (line 309): `          askRegistry: session.askRegistry,`
In `getOrRehydrate` (around line 235) delete: `      askRegistry: createAskRegistry(makeEmit(sessionId)),`
In `createSession` (around lines 248-254) delete the local and the field:

```ts
      const askRegistry = createAskRegistry(makeEmit(sessionId))
```
and the `askRegistry,` line inside the `sessions.set(sessionId, { ... })` object.

Delete the `resolveAsk` implementation (lines 353-355):

```ts
    resolveAsk(sessionId, askId, answer) {
      sessions.get(sessionId)?.askRegistry.resolve(askId, answer)
    },
```

In `cancelTask` delete the cancelAll line (361) and its comment (360):

```ts
      // Unblock any tool waiting on a human choice so the aborted run can settle.
      sessions.get(sessionId)?.askRegistry.cancelAll('Cancelled by user.')
```

(The `cancelTask` body keeps `log.info(...)` and `runHandles.get(taskId)?.abort()`.)

- [ ] **Step 7: Remove the `respondAsk` dispatcher case**

In `src/service/dispatcher.ts` delete the case (lines 83-87):

```ts
      case 'respondAsk': {
        const [sessionId, askId, answer] = args as [string, string, string]
        manager.resolveAsk(sessionId, askId, answer)
        return { ok: true }
      }
```

- [ ] **Step 8: Update the `render_ui` description and drop the dangling comment**

In `src/service/tools/render-ui.ts`, replace the leading comment (lines 14-16) — remove the "unlike ask_user" reference:

Current:
```ts
// Renders a typed UI card into the conversation. Non-blocking: the tool returns
```
…ending with a clause `… so there is no awaited promise here — unlike ask_user.`

Replace that whole comment paragraph with:
```ts
// Renders a typed UI card into the conversation. Non-blocking: the tool returns
// immediately and the card rides the persisted tool-call event. Interactive
// cards (e.g. 'choice') surface the user's click as a brand-new user message,
// so there is no awaited promise here.
```

And extend the tool `description` string (the `'Render a typed UI card …'` text at line ~28) so the model knows to use it for decisions. Append this sentence to the existing description:

```
' Use type "choice" with a question and options when you need the user to make a decision; their click is returned to you as a new user message.'
```

(Concatenate as another string in the existing `+`-joined description literal. Keep the rest verbatim.)

- [ ] **Step 9: Remove the `askUser` stub from the 8 tool test mocks**

In each of `fs.test.ts`, `memory.test.ts`, `plan.test.ts`, `shell.test.ts`, `web.test.ts`, `registry.test.ts`, `cron.test.ts`, `render-ui.test.ts` (all under `src/service/tools/`), delete the line:

```ts
  askUser: async () => '',
```

(These mock objects are typed `const ctx: ToolRunContext = { ... }`, so the now-excess `askUser` property would be a type error if left.)

- [ ] **Step 10: Verify type-clean, tests green, and no dangling backend refs**

Run: `npx tsc --noEmit -p tsconfig.node.json --composite false`
Expected: clean (no errors).

Run: `npm test`
Expected: all pass. (The `ask-registry.test.ts` suite is gone; `builtins.test.ts` passes without `agent.ask_user`.)

Run: `grep -rnE "askRegistry|askUser|ask_user|createAskRegistry|resolveAsk|AskRegistry" src/service`
Expected: **no output** (zero dangling backend references). The shared `respondAsk` IPC method string and the renderer still exist — those are removed in Tasks 2-3; do not grep those layers here.

- [ ] **Step 11: Lint and commit**

```bash
npx biome check --write src/service/tools/builtins.ts src/service/tools/builtins.test.ts src/service/tools/registry.ts src/service/agent-runner.ts src/service/session-manager.ts src/service/dispatcher.ts src/service/tools/render-ui.ts src/service/tools/fs.test.ts src/service/tools/memory.test.ts src/service/tools/plan.test.ts src/service/tools/shell.test.ts src/service/tools/web.test.ts src/service/tools/registry.test.ts src/service/tools/cron.test.ts src/service/tools/render-ui.test.ts
git add -A
git commit -m "refactor(tools): remove ask_user tool and backend ask channel"
```

---

### Task 2: Remove the `task.ask` event and its renderer handling

**Files:**
- Modify: `src/shared/types/ui.ts` (remove the `task.ask` UIEvent variant, lines 43-52)
- Modify: `src/renderer/src/lib/apply-event.ts` (remove `case 'task.ask':`, line 89)
- Modify: `src/renderer/src/lib/apply-event.test.ts` (remove the "flips to awaiting_user on task.ask" test, lines 189-211)
- Modify: `src/renderer/src/hooks/use-events-subscription.ts` (remove `useAskStore` import line 11, `pushAsk` line 40, the `task.ask` handler lines 85-93, drop `'task.ask'` from `TOAST_KINDS` line 17, fix comment line 22)

**Interfaces:**
- Consumes: Task 1 removed the only emitter of `task.ask` (askRegistry). After this task the `task.ask` event kind no longer exists in the `UIEvent` union.
- Produces: `UIEvent` has no `task.ask` member. `applyEvent` flips to `awaiting_user` only on `task.permission_request`.

- [ ] **Step 1: Remove the `task.ask` UIEvent variant**

In `src/shared/types/ui.ts`, delete the union member (lines 43-52):

```ts
  | {
      kind: 'task.ask'
      sessionId: string
      taskId: string
      askId: string
      question: string
      options: { label: string; value?: string }[]
      mode: 'single' | 'multi'
      ts: number
    }
```

(The `task.permission_request` member above and `task.complete` member below remain, joined by `|`.)

- [ ] **Step 2: Remove the `task.ask` case in `apply-event.ts`**

In `src/renderer/src/lib/apply-event.ts`, change the combined case (lines 88-91) from:

```ts
    case 'task.permission_request':
    case 'task.ask':
      updated = setStatus(updated, 'awaiting_user')
      break
```

to:

```ts
    case 'task.permission_request':
      updated = setStatus(updated, 'awaiting_user')
      break
```

- [ ] **Step 3: Remove the `task.ask` reducer test**

In `src/renderer/src/lib/apply-event.test.ts`, delete the entire `it('flips to awaiting_user on task.ask', () => { ... })` block (lines 189-211). Leave the surrounding tests (the `task.usage` test above and the `task.plan` test below) intact.

- [ ] **Step 4: Remove `task.ask` handling from the event subscription**

In `src/renderer/src/hooks/use-events-subscription.ts`:

Delete the import (line 11): `import { useAskStore } from '@/stores/ask'`

Change `TOAST_KINDS` (line 17) from:
```ts
const TOAST_KINDS = new Set(['task.created', 'task.complete', 'task.ask', 'task.permission_request'])
```
to:
```ts
const TOAST_KINDS = new Set(['task.created', 'task.complete', 'task.permission_request'])
```

Fix the comment (line 22) from:
```ts
  return `「${title}」需要你的回复` // task.ask / task.permission_request
```
to:
```ts
  return `「${title}」需要你的回复` // task.permission_request
```

Delete the `pushAsk` selector (line 40): `  const pushAsk = useAskStore((s) => s.push)`

Delete the `task.ask` handler (lines 85-93):
```ts
      if (e.kind === 'task.ask') {
        pushAsk({
          askId: e.askId,
          sessionId: e.sessionId,
          taskId: e.taskId,
          question: e.question,
          options: e.options,
          mode: e.mode,
        })
      }
```

Remove `pushAsk` from the `useEffect` dependency array (line 96): change `[qc, push, pushAsk, navigate]` to `[qc, push, navigate]`.

- [ ] **Step 5: Verify type-clean, tests green, no dangling `task.ask` refs**

Run: `npm run typecheck`
Expected: clean (node + web).

Run: `npm test`
Expected: all pass (apply-event suite passes without the removed test).

Run: `grep -rnE "task\.ask|pushAsk" src`
Expected: **no output**. (`stores/ask.ts` and `ask-panel.tsx` still exist but no longer reference `task.ask`; they are deleted in Task 3. `tasks-view.tsx` still imports `useAskStore` — that is removed in Task 3.)

- [ ] **Step 6: Lint and commit**

```bash
npx biome check --write src/shared/types/ui.ts src/renderer/src/lib/apply-event.ts src/renderer/src/lib/apply-event.test.ts src/renderer/src/hooks/use-events-subscription.ts
git add -A
git commit -m "refactor(events): remove task.ask event and renderer handling"
```

---

### Task 3: Remove the AskPanel UI and the `respondAsk` IPC chain

**Files:**
- Delete: `src/renderer/src/components/ask-panel.tsx`
- Delete: `src/renderer/src/stores/ask.ts`
- Modify: `src/renderer/src/components/views/tasks-view.tsx` (remove all ask wiring; keep `onSend`)
- Modify: `src/renderer/src/lib/api.ts` (remove `respondAsk`, lines 19-20)
- Modify: `src/preload/index.ts` (remove `respondAsk` bridge, lines 153-154)
- Modify: `src/main/ipc/swarm-ipc.ts` (remove `respondAsk` handler ~154-158, `ipcMain.handle('swarm:respondAsk')` line 177, `removeHandler('swarm:respondAsk')` line 264)
- Modify: `src/main/service-client.ts` (remove `respondAsk` from interface line 42, impl lines 125-127)
- Modify: `src/shared/types/service-ipc.ts` (remove `'respondAsk'` from method union, line 15)
- Modify: `src/shared/types/ui.ts` (remove `respondAsk` from the SwarmApi interface, line 217)

**Interfaces:**
- Consumes: Task 1 already removed the dispatcher handler for `'respondAsk'`; this task removes the method name and the whole renderer→preload→main→service-client call path plus the UI.
- Produces: no `respondAsk` anywhere; no `AskPanel`; no `useAskStore`. The transcript's `ui.render_ui` `choice` card (with its `onSend`) is the only decision-prompt path.

- [ ] **Step 1: Delete the UI component and the store**

```bash
git rm src/renderer/src/components/ask-panel.tsx src/renderer/src/stores/ask.ts
```

- [ ] **Step 2: Clean `tasks-view.tsx`**

Replace the full contents of `src/renderer/src/components/views/tasks-view.tsx` with:

```tsx
import { providerViewById } from '@shared/types/provider'

import { ChatInput } from '@/components/chat-input'
import { ConversationThread } from '@/components/conversation-thread'
import { PermissionDrawer } from '@/components/permission-drawer'
import { RightPanel } from '@/components/right-panel'
import { useProviders } from '@/hooks/use-providers'
import { useCancelTask, useDecidePermission, useSubmitGoal, useTasks } from '@/hooks/use-tasks'
import { usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

export function TasksView(): React.JSX.Element {
  const tasks = useTasks()
  const queue = usePermissionStore((s) => s.queue)
  const selectedSessionId = useSessionsStore((s) => s.selectedSessionId)
  const submitGoal = useSubmitGoal()
  const cancelTask = useCancelTask()
  const decide = useDecidePermission()
  const { ready, state } = useProviders()

  const sessionTasks = tasks.filter((t) => t.sessionId === selectedSessionId)
  // Runs are sequential per session, so at most one task is in flight; the
  // event reducer prepends newest-first, so find() yields the active run.
  // 'awaiting_user' counts as in-flight: the run is blocked on a permission
  // prompt but still cancellable, and no event resets it back to 'running'.
  const activeTask = sessionTasks.find(
    (t) => t.status === 'running' || t.status === 'pending' || t.status === 'awaiting_user'
  )
  const currentPrompt = queue.find((p) => p.sessionId === selectedSessionId) ?? null
  const byRecent = [...sessionTasks].sort((a, b) => b.startedAt - a.startedAt)
  // Most recent plan in the session (the agent replaces it wholesale).
  const activePlan = byRecent.find((t) => t.plan && t.plan.length > 0)?.plan
  // Context-window fill for the composer ring follows the most recent task.
  const latestTask = byRecent[0]

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <ConversationThread
          onSend={(text) => {
            if (!ready) return
            void submitGoal.mutateAsync({ goal: text })
          }}
          tasks={sessionTasks}
        />
        <PermissionDrawer
          onDecide={(actionId, decision) => {
            if (!currentPrompt) return
            decide.mutate({ sessionId: currentPrompt.sessionId, actionId, decision })
          }}
          prompt={currentPrompt}
        />
        <ChatInput
          cacheReadTokens={latestTask?.used?.cacheRead}
          contextTokens={latestTask?.contextTokens}
          contextWindow={latestTask?.contextWindow}
          disabled={!ready}
          onStop={() => {
            if (activeTask) cancelTask.mutate({ sessionId: activeTask.sessionId, taskId: activeTask.id })
          }}
          onSubmit={async (g, attachments) => {
            if (!ready) return
            await submitGoal.mutateAsync({ goal: g, attachments })
          }}
          status={activeTask ? (activeTask.status === 'pending' ? 'submitted' : 'streaming') : 'ready'}
          supportsImages={!!providerViewById(state, state.active)?.supportsImages}
          usdCents={latestTask?.used?.usdCents}
        />
      </div>
      <RightPanel plan={activePlan ?? []} />
    </div>
  )
}
```

(Removed: `AskPanel` import + render, `useAskStore`/`AskPrompt` import and all ask state, `swarmApi` import, `answerAsk`/`chatAboutAsk`, the `pendingChat` branch in `onSubmit`, and the `placeholder` prop. `ChatInput` keeps its built-in default placeholder.)

- [ ] **Step 3: Remove `respondAsk` from the renderer API wrapper**

In `src/renderer/src/lib/api.ts`, delete (lines 19-20):

```ts
  respondAsk: (sessionId: string, askId: string, answer: string): Promise<void> =>
    window.swarm.respondAsk(sessionId, askId, answer),
```

- [ ] **Step 4: Remove `respondAsk` from the preload bridge**

In `src/preload/index.ts`, delete (lines 153-154):

```ts
  respondAsk: (sessionId, askId, answer) =>
    ipcRenderer.invoke('swarm:respondAsk', sessionId, askId, answer) as Promise<void>,
```

- [ ] **Step 5: Remove `respondAsk` from the main IPC handler**

In `src/main/ipc/swarm-ipc.ts`:

Delete the handler function (lines 154-158):
```ts
  const respondAsk = (_e: Electron.IpcMainInvokeEvent, sessionId: string, askId: string, answer: string): void => {
    serviceClient
      .respondAsk(sessionId, askId, answer)
      .catch((err: unknown) => log.warn({ msg: 'respondAsk failed', err: String(err) }))
    log.info({ msg: 'ask answered', sessionId, askId })
  }
```

Delete the registration (line 177): `  ipcMain.handle('swarm:respondAsk', respondAsk)`
Delete the teardown (line 264): `      ipcMain.removeHandler('swarm:respondAsk')`

- [ ] **Step 6: Remove `respondAsk` from the service client**

In `src/main/service-client.ts`:

Delete the interface member (line 42): `  respondAsk(sessionId: string, askId: string, answer: string): Promise<void>`
Delete the implementation (lines 125-127):
```ts
    async respondAsk(sessionId, askId, answer) {
      await call('respondAsk', [sessionId, askId, answer])
    },
```

- [ ] **Step 7: Remove `'respondAsk'` from the shared method union**

In `src/shared/types/service-ipc.ts`, delete the union member (line 15): `  | 'respondAsk'`

- [ ] **Step 8: Remove `respondAsk` from the SwarmApi interface**

In `src/shared/types/ui.ts`, delete (line 217): `  respondAsk(sessionId: string, askId: string, answer: string): Promise<void>`

- [ ] **Step 9: Verify type-clean, full tests, build, and zero dangling refs**

Run: `npm run typecheck`
Expected: clean (node + web).

Run: `npm test`
Expected: all pass.

Run: `grep -rinE "respondAsk|AskPanel|useAskStore|AskPrompt|AskOption|AskMode|ask-panel|stores/ask|ask_user|askRegistry" src`
Expected: **no output** anywhere in `src` (full removal complete).

Run: `npx electron-vite build`
Expected: build succeeds (renderer + main bundles emitted).

- [ ] **Step 10: Lint and commit**

```bash
npx biome check --write src/renderer/src/components/views/tasks-view.tsx src/renderer/src/lib/api.ts src/preload/index.ts src/main/ipc/swarm-ipc.ts src/main/service-client.ts src/shared/types/service-ipc.ts src/shared/types/ui.ts
git add -A
git commit -m "refactor(ipc): remove respondAsk IPC chain and AskPanel UI"
```

---

### Task 4: Live smoke test — decisions now flow through `render_ui`

**Files:** none (verification only).

**Interfaces:** exercises the full removal in the running app and confirms the `render_ui` `choice` card still covers the decision use case.

- [ ] **Step 1: Launch the built app**

Use the `run-desktop` skill to build (if needed) and launch the app.

- [ ] **Step 2: Confirm a clean boot**

Screenshot the main window. Expected: app boots, sidebar + composer render, no console/runtime error referencing `ask`, `respondAsk`, or `AskPanel`.

- [ ] **Step 3: Drive a decision via render_ui**

In a session whose allowlist includes `ui.render_ui` (default `*`), prompt: *"用 render_ui 渲染 type=choice, props={question:'部署到哪个环境?', options:[{label:'staging'},{label:'production'}], mode:'single'}"*.
Expected: an inline choice card with two option buttons (no AskPanel above the composer). Click `staging`.
Expected: a new user message `staging` is sent and the agent processes it as a fresh turn.

- [ ] **Step 4: Confirm the old path is gone**

Verify no AskPanel/“Chat about this” affordance appears anywhere during the run, and the composer placeholder is its default (never "Reply to the agent…").

- [ ] **Step 5: Check the log file**

Inspect `userData/swarm-dev.log`. Expected: `render_ui card emitted` info lines; no `ask answered` / `respondAsk` lines.

---

## Migration notes

- **Semantic change (intended):** decisions are now non-blocking. The agent finishes its turn after rendering a `choice` card; the user's click starts a new turn. There is no longer a blocking "tool result = answer" path. This was the explicit decision (option 2).
- **"Chat about this" is subsumed:** with no blocked ask, the composer is always free, so the user can simply type a free-text reply as a normal new turn. The dedicated affordance is removed.
- **No data migration:** `task.ask` was a live broadcast, never persisted to `task_events`, so historical sessions are unaffected. `awaiting_user` status is retained for `task.permission_request`.
