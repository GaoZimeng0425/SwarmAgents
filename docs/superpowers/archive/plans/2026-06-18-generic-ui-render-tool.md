# Generic UI Render Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-blocking `ui.render_ui` tool that emits a typed UI card into the conversation transcript; the renderer dispatches by `type` to a component registry, and interactive cards send the user's click back as a new message.

**Architecture:** The agent calls `render_ui({ type, props })`. This lands in the persisted event stream as a normal `tool.call` (args = the UI spec) and is flattened by `taskSegments` into a `kind:'tool'` segment. `renderSegment` intercepts segments whose `tool === 'render_ui'` and dispatches to a frontend renderer registry keyed by `spec.type`, falling back to the generic `Tool` card for unknown types. Interactive renderers receive an `onSend(text)` callback threaded from `TasksView` → `ConversationThread`, which calls the existing `submitGoal` mutation to start a fresh user turn. The tool returns immediately — no `askRegistry`, no blocking. Data is persisted for free because it rides the existing tool-call event.

**Tech Stack:** TypeScript, Electron, React, Zustand, TanStack Query, `@earendil-works/pi-ai` (`Type` schema), `@earendil-works/pi-agent-core` (`AgentTool`), Vitest (run via `npm test`).

## Global Constraints

- Reply to the user in Chinese; **code comments and commit messages in English only** (project CLAUDE.md §0).
- Run tests with `npm test` (Electron node ABI) — **never** `npx vitest` directly, never `pnpm rebuild better-sqlite3` (project memory).
- Scoped lint/format: `npx biome check --write <file>` — `pnpm check`/`format` reformat the whole repo (project memory).
- Every business path gets structured `pino` logs via `createLogger` (project CLAUDE.md §5); match existing tool call-site shape.
- Surgical changes only: do **not** remove or modify the existing `ask_user` tool / `AskPanel` / `askRegistry` in this plan — `render_ui` is additive and lives alongside them (CLAUDE.md §3).
- Tool group is `ui`, model-facing name is `render_ui`; allowlist patterns `ui.render_ui` or `ui.*`.

---

### Task 1: Backend `render_ui` tool (non-blocking)

**Files:**
- Create: `src/service/tools/render-ui.ts`
- Create: `src/service/tools/render-ui.test.ts`
- Modify: `src/service/tools/builtins.ts` (import + register, mirror `askUserSpec` at line 58)
- Modify: `src/service/tools/builtins.test.ts:38` (add `'ui.render_ui'` to the expected builtin names)

**Interfaces:**
- Consumes: `ToolSpec`, `ToolRunContext` from `./registry`; `Type` from `@earendil-works/pi-ai`; `AgentTool` from `@earendil-works/pi-agent-core`.
- Produces: `renderUiSpec(): ToolSpec` — a builtin spec, `group: 'ui'`, `name: 'render_ui'`, `risk: 'low'`. The built `AgentTool.execute` validates `{ type, props }` and returns immediately; it does **not** call `ctx.askUser` or block. Tool result on success: `{ content: [{ type: 'text', text: 'rendered ui card: <type>' }], details: { type, props } }`. On invalid input: `{ content: [{ type: 'text', text: 'error: <msg>' }], details: { error: msg } }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/service/tools/render-ui.test.ts
import { describe, expect, it } from 'vitest'

import type { ToolRunContext } from './registry'
import { renderUiSpec } from './render-ui'

const ctx = {
  sessionId: 's1',
  taskId: 't1',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  send: () => undefined,
  requestPermission: async () => 'grant' as const,
  askUser: async () => '',
} as unknown as ToolRunContext

describe('render_ui', () => {
  it('returns the spec as details without blocking on askUser', async () => {
    const tool = renderUiSpec().build(ctx)
    const res = (await tool.execute('id', { type: 'weather', props: { city: 'SF', tempC: 18 } })) as {
      details: { type?: string; props?: unknown; error?: string }
    }
    expect(res.details.error).toBeUndefined()
    expect(res.details.type).toBe('weather')
    expect(res.details.props).toEqual({ city: 'SF', tempC: 18 })
  })

  it('errors when type is missing or blank', async () => {
    const tool = renderUiSpec().build(ctx)
    const res = (await tool.execute('id', { props: {} })) as { details: { error?: string } }
    expect(res.details.error).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- render-ui`
Expected: FAIL — `Cannot find module './render-ui'` (file not yet created).

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/service/tools/render-ui.ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'

import type { ToolRunContext, ToolSpec } from './registry'

const log = createLogger({ process: 'service' }).child({ component: 'render-ui' })

const RenderUiParams = Type.Object({
  type: Type.String({ description: "UI card type, e.g. 'weather' | 'choice'. Frontend renders by this key." }),
  props: Type.Optional(Type.Any({ description: 'Arbitrary data the chosen renderer consumes.' })),
})

// Renders a typed UI card into the conversation. Non-blocking: the tool returns
// immediately and the card rides the persisted tool-call event. Interactive
// cards (e.g. 'choice') surface the user's click as a brand-new user message,
// so there is no awaited promise here — unlike ask_user.
export function renderUiSpec(): ToolSpec {
  return {
    group: 'ui',
    name: 'render_ui',
    risk: 'low',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'render_ui',
      label: 'Render a UI card',
      description:
        'Render a typed UI card in the conversation (e.g. a weather card, a choice prompt). ' +
        'Non-blocking: returns immediately. If the card is interactive, the user\'s click arrives ' +
        'later as a new user message — do not wait on this call for an answer.',
      parameters: RenderUiParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { type?: unknown; props?: unknown }
        const type = typeof p.type === 'string' ? p.type.trim() : ''
        const toolLog = log.child({ sessionId: ctx.sessionId, taskId: ctx.taskId })
        if (!type) {
          const msg = 'render_ui needs a non-empty "type"'
          toolLog.warn({ msg: 'render_ui invalid input' })
          return { content: [{ type: 'text', text: `error: ${msg}` }], details: { error: msg } }
        }
        toolLog.info({ msg: 'render_ui card emitted', type })
        return {
          content: [{ type: 'text', text: `rendered ui card: ${type}` }],
          details: { type, props: p.props },
        }
      },
    }),
  }
}
```

- [ ] **Step 4: Register the tool**

In `src/service/tools/builtins.ts`, add the import next to the `askUserSpec` import (line 6):

```typescript
import { renderUiSpec } from './render-ui'
```

And register it right after `askUserSpec()` (line 58):

```typescript
  registry.register(askUserSpec())
  registry.register(renderUiSpec())
```

- [ ] **Step 5: Update the builtins registration test**

In `src/service/tools/builtins.test.ts`, add `'ui.render_ui'` to the expected names list near `'agent.ask_user'` (line 38). Keep alphabetical/existing ordering of the surrounding assertion if the test sorts; otherwise append in the same style as neighbors.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- render-ui builtins`
Expected: PASS — both `render-ui` tests and the builtins registration test pass.

- [ ] **Step 7: Lint touched files**

Run: `npx biome check --write src/service/tools/render-ui.ts src/service/tools/render-ui.test.ts src/service/tools/builtins.ts src/service/tools/builtins.test.ts`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/service/tools/render-ui.ts src/service/tools/render-ui.test.ts src/service/tools/builtins.ts src/service/tools/builtins.test.ts
git commit -m "feat(tools): add non-blocking ui.render_ui tool"
```

---

### Task 2: Frontend renderer registry

**Files:**
- Create: `src/renderer/src/components/ui-renderers/index.tsx`
- Create: `src/renderer/src/components/ui-renderers/index.test.ts`

**Interfaces:**
- Produces:
  - `type UiRendererProps = { props: unknown; onSend?: (text: string) => void; disabled?: boolean }`
  - `type UiRenderer = React.FC<UiRendererProps>`
  - `getUiRenderer(type: string): UiRenderer | undefined` — registry lookup; returns `undefined` for unknown types (caller falls back to the generic `Tool` card).
  - `ChoiceCard` and `WeatherCard` registered renderers (defined in this file).
- Consumes: `Button` from `@/components/ui/button`.

- [ ] **Step 1: Write the failing test (pure registry lookup)**

```typescript
// src/renderer/src/components/ui-renderers/index.test.ts
import { describe, expect, it } from 'vitest'

import { getUiRenderer } from './index'

describe('getUiRenderer', () => {
  it('returns a component for known types', () => {
    expect(typeof getUiRenderer('choice')).toBe('function')
    expect(typeof getUiRenderer('weather')).toBe('function')
  })

  it('returns undefined for unknown types', () => {
    expect(getUiRenderer('nope')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ui-renderers`
Expected: FAIL — `Cannot find module './index'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/renderer/src/components/ui-renderers/index.tsx
import { useState } from 'react'

import { Button } from '@/components/ui/button'

export type UiRendererProps = {
  props: unknown
  /** Interactive cards call this to start a new user turn with the chosen value. */
  onSend?: (text: string) => void
  /** Disabled while a run is in flight to avoid double submits. */
  disabled?: boolean
}

export type UiRenderer = React.FC<UiRendererProps>

type ChoiceOption = { label: string; value?: string }
type ChoiceSpec = { question?: string; options?: ChoiceOption[]; mode?: 'single' | 'multi' }

const optionValue = (o: ChoiceOption): string => o.value ?? o.label

const ChoiceCard: UiRenderer = ({ props, onSend, disabled }) => {
  const spec = (props ?? {}) as ChoiceSpec
  const options = (spec.options ?? []).filter((o) => typeof o?.label === 'string' && o.label.trim().length > 0)
  const mode = spec.mode === 'multi' ? 'multi' : 'single'
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggle = (v: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      return next
    })

  return (
    <div className="rounded-xl border border-border bg-popover/95 px-4 py-3 shadow-sm">
      {spec.question && <p className="mb-3 font-medium text-sm">{spec.question}</p>}
      {mode === 'single' ? (
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <Button
              disabled={disabled}
              key={optionValue(o)}
              onClick={() => onSend?.(optionValue(o))}
              size="sm"
              variant="secondary"
            >
              {o.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {options.map((o) => {
              const v = optionValue(o)
              return (
                <Button
                  disabled={disabled}
                  key={v}
                  onClick={() => toggle(v)}
                  size="sm"
                  variant={selected.has(v) ? 'default' : 'secondary'}
                >
                  {o.label}
                </Button>
              )
            })}
          </div>
          <Button
            disabled={disabled || selected.size === 0}
            onClick={() => onSend?.([...selected].join(', '))}
            size="sm"
          >
            Submit
          </Button>
        </div>
      )}
    </div>
  )
}

type WeatherSpec = { city?: string; tempC?: number; summary?: string }

const WeatherCard: UiRenderer = ({ props }) => {
  const spec = (props ?? {}) as WeatherSpec
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-popover/95 px-4 py-3 shadow-sm">
      <div className="font-medium text-sm">{spec.city ?? 'Unknown'}</div>
      {typeof spec.tempC === 'number' && <div className="text-2xl tabular-nums">{spec.tempC}°C</div>}
      {spec.summary && <div className="text-muted-foreground text-sm">{spec.summary}</div>}
    </div>
  )
}

const REGISTRY: Record<string, UiRenderer> = {
  choice: ChoiceCard,
  weather: WeatherCard,
}

export function getUiRenderer(type: string): UiRenderer | undefined {
  return REGISTRY[type]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ui-renderers`
Expected: PASS.

- [ ] **Step 5: Lint touched files**

Run: `npx biome check --write src/renderer/src/components/ui-renderers/index.tsx src/renderer/src/components/ui-renderers/index.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/ui-renderers/index.tsx src/renderer/src/components/ui-renderers/index.test.ts
git commit -m "feat(renderer): add ui-renderer registry with choice and weather cards"
```

---

### Task 3: Dispatch in the transcript + thread `onSend`

**Files:**
- Modify: `src/renderer/src/components/conversation-thread.tsx` (add `onSend` to `Props`, dispatch in `renderSegment` tool branch at lines 186-206, pass `busy` for `disabled`)
- Modify: `src/renderer/src/components/views/tasks-view.tsx` (pass `onSend` to `ConversationThread` using `submitGoal`)

**Interfaces:**
- Consumes: `getUiRenderer` from `@/components/ui-renderers` (Task 2); `submitGoal` from `useSubmitGoal()` (already imported in `tasks-view.tsx:24`).
- Produces: `ConversationThread` gains an optional `onSend?: (text: string) => void` prop. When a tool segment has `tool === 'render_ui'` and a renderer is registered for `seg.input.type`, it renders the registered component instead of the generic `Tool` card.

- [ ] **Step 1: Add the `onSend` prop to `ConversationThread`**

Find the `Props` type in `conversation-thread.tsx` (referenced at the `ConversationThread({ tasks }: Props)` signature, line 104) and add `onSend`:

```tsx
type Props = {
  tasks: TaskRecord[]
  /** Start a new user turn with the given text (used by interactive UI cards). */
  onSend?: (text: string) => void
}
```

Update the signature:

```tsx
export function ConversationThread({ tasks, onSend }: Props): React.JSX.Element {
```

(If the existing `Props` already lists `tasks` with a comment, keep that line verbatim and only append the `onSend` field.)

- [ ] **Step 2: Add the renderer import**

At the top of `conversation-thread.tsx`, with the other `@/components` imports:

```tsx
import { getUiRenderer } from '@/components/ui-renderers'
```

- [ ] **Step 3: Dispatch to the renderer in the tool branch**

In `renderSegment`, at the start of the `if (seg.kind === 'tool')` block (line 186), before building the generic `Tool` card, insert:

```tsx
    if (seg.kind === 'tool') {
      if (seg.tool === 'render_ui') {
        const spec = (seg.input ?? {}) as { type?: string; props?: unknown }
        const Renderer = typeof spec.type === 'string' ? getUiRenderer(spec.type) : undefined
        if (Renderer) {
          return (
            <div className="my-4" key={seg.key}>
              <Renderer disabled={busy} onSend={onSend} props={spec.props} />
            </div>
          )
        }
        // Unknown type → fall through to the generic Tool card below.
      }
```

The existing `const preview = ...` line and generic `Tool` return stay unchanged immediately after, serving as the fallback for unknown types.

- [ ] **Step 4: Pass `onSend` from `TasksView`**

In `src/renderer/src/components/views/tasks-view.tsx`, change the `ConversationThread` usage (line 58) to:

```tsx
        <ConversationThread
          onSend={(text) => {
            if (!ready) return
            void submitGoal.mutateAsync({ goal: text })
          }}
          tasks={sessionTasks}
        />
```

(`submitGoal`, `ready` are already in scope from lines 24 and 27.)

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npx biome check --write src/renderer/src/components/conversation-thread.tsx src/renderer/src/components/views/tasks-view.tsx`
Expected: no errors.

- [ ] **Step 6: Run the full unit suite (no regressions)**

Run: `npm test`
Expected: PASS — including the existing `task-segments` tests (untouched).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/conversation-thread.tsx src/renderer/src/components/views/tasks-view.tsx
git commit -m "feat(renderer): dispatch render_ui segments to the renderer registry"
```

---

### Task 4: End-to-end manual verification in the app

**Files:** none (verification only).

**Interfaces:** exercises Tasks 1-3 together via the running desktop app.

- [ ] **Step 1: Launch the app**

Use the `run-desktop` skill to build and launch the SwarmAgents Electron app (the project-specific launcher; do not improvise a raw `electron .`).

- [ ] **Step 2: Enable the tool for a session**

Ensure the active task's tool allowlist includes `ui.render_ui` (or `ui.*` / `*`). If the session UI exposes an allowlist editor, add it there; otherwise start a session whose default allowlist already contains `*`.

- [ ] **Step 3: Trigger a weather card (non-interactive)**

Prompt the agent: *"用 render_ui 渲染一个天气卡片:type=weather, props={city:'Tokyo', tempC:24, summary:'Sunny'}"*.
Expected: a weather card (city / 24°C / Sunny) appears inline in the transcript — **not** a JSON tool card. Take a screenshot to confirm.

- [ ] **Step 4: Verify persistence**

Reload the renderer window (or reopen the session).
Expected: the weather card is still rendered from the persisted event stream (no JSON fallback, no disappearance).

- [ ] **Step 5: Trigger a choice card (interactive) and click**

Prompt: *"用 render_ui 渲染 type=choice, props={question:'部署到哪个环境?', options:[{label:'staging'},{label:'production'}], mode:'single'}"*.
Expected: two option buttons render inline. Click `staging`.
Expected: a new user message `staging` is sent and the agent responds to it as a fresh turn. Confirm via screenshot + log.

- [ ] **Step 6: Check the log file**

Inspect `userData/swarm-dev.log` (`SWARM_LOG_FILE`).
Expected: an `info` line `render_ui card emitted` with `type` for each card, and the standard tool start/ok debug lines from `withLogging`.

- [ ] **Step 7: Unknown-type fallback (regression guard)**

Prompt: *"用 render_ui 渲染 type=does-not-exist, props={}"*.
Expected: the generic `Tool` card renders (graceful fallback), no crash.

---

## Migration note (out of scope — do not implement here)

Once `render_ui` + the `choice` renderer are proven, the blocking `ask_user` path (`src/service/tools/ask.ts`, `AskPanel`, `createAskRegistry`, `swarm:respondAsk` IPC, `useAskStore`) becomes redundant for non-blocking decisions and could be removed in a follow-up. That removal touches `agent-runner.ts:288`, `session-manager.ts`, the preload bridge, and the ask store — a separate plan with its own review. Left intact here per the surgical-changes constraint.
