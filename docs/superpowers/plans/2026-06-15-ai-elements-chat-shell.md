# AI Elements Chat Shell (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-built chat UI with the ai-elements chat shell (stick-to-bottom message list + rich `prompt-input` composer + streamdown markdown + tool cards), wired to the existing `TaskRecord`/`UIEvent` model.

**Architecture:** Approach A — keep the ported ai-elements component files near-verbatim; rewrite `ConversationThread` and `ChatInput` to compose those primitives from `TaskRecord`/`UIEvent` via a pure `taskSegments` helper. No `UIMessage` adapter. The composer's `PromptInputSubmit` natively shows a Stop button when `status` is `streaming`/`submitted`, absorbing the existing Send→Stop feature. Attachments are UI-only (disabled) this phase.

**Tech Stack:** React 19, TanStack Query, Tailwind 4, ai-elements (shadcn-style), streamdown (+@streamdown/cjk|code|math|mermaid), shiki, use-stick-to-bottom, Vitest (Electron-as-node).

**Commands:**
- Single test file: `npm test -- <path>`
- Full suite: `npm test`
- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Format a single file: `npx biome check --write <file>` (never `npm run check` — it reformats the whole repo)

**Key facts (already verified):**
- The `@/*` alias maps to `src/renderer/src/*`; ported components' `@/components/ui/*` and `@/lib/utils` imports resolve to existing files.
- All needed runtime deps are already installed (`streamdown`, `@streamdown/*`, `shiki`, `nanoid`, `use-stick-to-bottom`, `@radix-ui/react-use-controllable-state`).
- Sibling imports among ported files: `tool.tsx → ./code-block`, `reasoning.tsx → ./shimmer`. No other cross-file imports.
- `PromptInput` auto-resets the textarea after `onSubmit` (we don't manage its value).
- `PromptInputSubmit` props: `status?: ChatStatus`, `onStop?: () => void`; when `status` is `submitted`/`streaming` and `onStop` is set, clicking calls `onStop` (it becomes a Stop button).
- `ToolHeader` requires `type` (a `tool-${string}`) and `state` (e.g. `'input-available' | 'output-available' | 'output-error'`); accepts optional `title`.

---

### Task 1: Port the ai-elements component files into the renderer

**Files:**
- Create (copy verbatim from `src/components/ai-elements/`): `src/renderer/src/components/ai-elements/{conversation,message,prompt-input,tool,reasoning,code-block,shimmer}.tsx`

- [ ] **Step 1: Copy the seven files**

```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents
mkdir -p src/renderer/src/components/ai-elements
for f in conversation message prompt-input tool reasoning code-block shimmer; do
  cp "src/components/ai-elements/$f.tsx" "src/renderer/src/components/ai-elements/$f.tsx"
done
```

Do NOT edit the files — their `@/components/ui/*` and `@/lib/utils` imports resolve via the renderer alias, and their only sibling imports (`./code-block`, `./shimmer`) are included in the copied set.

- [ ] **Step 2: Typecheck to confirm imports resolve**

Run: `npm run typecheck`
Expected: PASS. If a `@/components/ui/<x>` import fails to resolve, that ui primitive is missing from `src/renderer/src/components/ui/` — STOP and report it (the renderer is expected to have the full base-nova set; a miss means a wrong assumption).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/ai-elements
git commit -m "feat(ui): port ai-elements chat components into the renderer"
```

---

### Task 2: `taskSegments` helper (extract + extend `bubblesFor`)

**Files:**
- Create: `src/renderer/src/lib/task-segments.ts`
- Test: `src/renderer/src/lib/task-segments.test.ts`

This is the pure core: it turns a `TaskRecord` into ordered render segments, preserving today's `bubblesFor` behavior (assistant-delta coalescing, `update_plan` call+result suppression, inner-error and permission rows, cancelled→"stopped") and additionally **pairs** each `tool.call` with its following `tool.result` into one `tool` segment.

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/lib/task-segments.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { TaskRecord } from './apply-event'
import { taskSegments } from './task-segments'

function rec(events: TaskRecord['events']): TaskRecord {
  return {
    id: 't1',
    sessionId: 's1',
    goal: 'do x',
    status: 'running',
    workerId: null,
    summary: null,
    startedAt: 1,
    events,
  }
}
const prog = (event: unknown) =>
  ({ kind: 'task.progress', sessionId: 's1', taskId: 't1', event, ts: 1 }) as TaskRecord['events'][number]

describe('taskSegments', () => {
  it('emits the goal as the first user segment', () => {
    const segs = taskSegments(rec([]))
    expect(segs[0]).toMatchObject({ kind: 'user', text: 'do x' })
  })

  it('coalesces consecutive assistant deltas into one segment', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'llm.message', role: 'assistant', content: 'Hel', ts: 1 }),
        prog({ kind: 'llm.message', role: 'assistant', content: 'lo', ts: 2 }),
      ])
    )
    const assistant = segs.filter((s) => s.kind === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]).toMatchObject({ text: 'Hello' })
  })

  it('pairs a tool.call with its tool.result into one tool segment', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'tool.call', server: 'fs', tool: 'read_file', args: { path: 'a' }, ts: 1 }),
        prog({ kind: 'tool.result', ok: true, payload: { text: 'contents' }, ts: 2 }),
      ])
    )
    const tools = segs.filter((s) => s.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ tool: 'read_file', ok: true, output: 'contents' })
    expect((tools[0] as { input: unknown }).input).toEqual({ path: 'a' })
  })

  it('marks a failed tool result with ok:false', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'tool.call', server: 'fs', tool: 'read_file', args: {}, ts: 1 }),
        prog({ kind: 'tool.result', ok: false, payload: { text: 'boom' }, ts: 2 }),
      ])
    )
    expect(segs.find((s) => s.kind === 'tool')).toMatchObject({ ok: false, output: 'boom' })
  })

  it('suppresses the update_plan call and its following result', () => {
    const segs = taskSegments(
      rec([
        prog({ kind: 'tool.call', server: 'plan', tool: 'update_plan', args: {}, ts: 1 }),
        prog({ kind: 'tool.result', ok: true, payload: {}, ts: 2 }),
      ])
    )
    expect(segs.some((s) => s.kind === 'tool' || s.kind === 'event')).toBe(false)
  })

  it('labels a cancelled task.error as "stopped", others as "error"', () => {
    const stopped = taskSegments(
      rec([{ kind: 'task.error', sessionId: 's1', taskId: 't1', error: { code: 'cancelled', message: 'Stopped by user.' }, ts: 1 }])
    )
    expect(stopped.find((s) => s.kind === 'error')).toMatchObject({ label: 'stopped', detail: 'Stopped by user.' })

    const failed = taskSegments(
      rec([{ kind: 'task.error', sessionId: 's1', taskId: 't1', error: { code: 'boom', message: 'nope' }, ts: 1 }])
    )
    expect(failed.find((s) => s.kind === 'error')).toMatchObject({ label: 'error', detail: 'nope' })
  })

  it('renders a permission_request as an event segment', () => {
    const segs = taskSegments(
      rec([{ kind: 'task.permission_request', sessionId: 's1', taskId: 't1', workerId: 'w', actionId: 'a', risk: 'medium', summary: 'run rm', payload: {}, ts: 1 }])
    )
    expect(segs.find((s) => s.kind === 'event')).toMatchObject({ label: 'permission (medium)', detail: 'run rm' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/renderer/src/lib/task-segments.test.ts`
Expected: FAIL — `taskSegments` does not exist / module not found.

- [ ] **Step 3: Implement the helper**

Create `src/renderer/src/lib/task-segments.ts`:

```ts
import type { UIEvent } from '@shared/types/ui'
import type { TaskRecord } from './apply-event'

export type Segment =
  | { kind: 'user'; text: string; key: string; taskId: string }
  | { kind: 'assistant'; text: string; key: string; taskId: string }
  | { kind: 'tool'; tool: string; ok: boolean | null; input: unknown; output: string | null; key: string; taskId: string }
  | { kind: 'event'; label: string; detail: string; key: string; taskId: string }
  | { kind: 'error'; label: 'error' | 'stopped'; detail: string; key: string; taskId: string }

function toolDetail(payload: unknown): string {
  const p = payload as { text?: string } | undefined
  return typeof p?.text === 'string' ? p.text : JSON.stringify(payload ?? {}, null, 2)
}

/** Flatten a task's UIEvents into ordered render segments. Pure; unit-tested. */
export function taskSegments(task: TaskRecord): Segment[] {
  const out: Segment[] = [{ kind: 'user', text: task.goal, key: `${task.id}-goal`, taskId: task.id }]

  const pushAssistant = (text: string, key: string): void => {
    const last = out[out.length - 1]
    if (last && last.kind === 'assistant') last.text += text
    else out.push({ kind: 'assistant', text, key, taskId: task.id })
  }

  // update_plan is rendered by PlanPanel, so its call AND following result are dropped.
  let skipNextToolResult = false
  // The tool.call awaiting its tool.result, so the pair merges into one segment.
  let pendingTool: Extract<Segment, { kind: 'tool' }> | null = null

  task.events.forEach((e: UIEvent, i) => {
    const key = `${task.id}-${i}`
    if (e.kind === 'task.progress') {
      const ev = e.event
      if (ev.kind === 'llm.message' && ev.role === 'assistant') {
        pushAssistant(typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content), key)
      } else if (ev.kind === 'tool.call') {
        if (ev.tool === 'update_plan') {
          skipNextToolResult = true
          return
        }
        pendingTool = { kind: 'tool', tool: ev.tool, ok: null, input: ev.args ?? {}, output: null, key, taskId: task.id }
        out.push(pendingTool)
      } else if (ev.kind === 'tool.result') {
        if (skipNextToolResult) {
          skipNextToolResult = false
          return
        }
        if (pendingTool) {
          pendingTool.ok = ev.ok
          pendingTool.output = toolDetail(ev.payload)
          pendingTool = null
        } else {
          out.push({ kind: 'event', label: ev.ok ? 'tool result' : 'tool error', detail: toolDetail(ev.payload), key, taskId: task.id })
        }
      } else if (ev.kind === 'error') {
        out.push({ kind: 'event', label: 'error', detail: ev.error.message ?? 'error', key, taskId: task.id })
      }
    } else if (e.kind === 'task.permission_request') {
      out.push({ kind: 'event', label: `permission (${e.risk})`, detail: e.summary, key, taskId: task.id })
    } else if (e.kind === 'task.error') {
      const err = typeof e.error === 'object' && e.error ? (e.error as { message?: unknown; code?: unknown }) : null
      const msg = err && 'message' in err ? String(err.message) : 'error'
      const label = err?.code === 'cancelled' ? 'stopped' : 'error'
      out.push({ kind: 'error', label, detail: msg, key, taskId: task.id })
    }
  })

  return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/renderer/src/lib/task-segments.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write src/renderer/src/lib/task-segments.ts src/renderer/src/lib/task-segments.test.ts
git add src/renderer/src/lib/task-segments.ts src/renderer/src/lib/task-segments.test.ts
git commit -m "feat(ui): taskSegments helper — flatten TaskRecord events to render segments"
```

---

### Task 3: Rewrite `ConversationThread` to render segments via ai-elements

**Files:**
- Modify (full rewrite): `src/renderer/src/components/conversation-thread.tsx`

Renders `taskSegments` through `Conversation`/`Message`/`Tool`. Stick-to-bottom replaces the manual `bottomRef`/`scrollIntoView`. Preserves: copy/delete actions, the busy indicator, the usage footer.

- [ ] **Step 1: Replace the file contents**

Overwrite `src/renderer/src/components/conversation-thread.tsx` with:

```tsx
import { useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Copy, MessagesSquare, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { Spinner } from '@/components/ui/spinner'
import { TASKS_KEY } from '@/hooks/use-tasks'
import type { TaskRecord } from '@/lib/apply-event'
import { formatUsage } from '@/lib/format-usage'
import { type Segment, taskSegments } from '@/lib/task-segments'

type Props = { tasks: TaskRecord[] }

// ToolHeader needs an AI-SDK-shaped tool type + state; derive both from our segment.
function toolState(ok: boolean | null): 'input-available' | 'output-available' | 'output-error' {
  if (ok === null) return 'input-available'
  return ok ? 'output-available' : 'output-error'
}

export function ConversationThread({ tasks }: Props): React.JSX.Element {
  const qc = useQueryClient()
  const ordered = [...tasks].sort((a, b) => a.startedAt - b.startedAt)

  const onCopy = (text: string): void => {
    void navigator.clipboard.writeText(text)
    toast.success('Message copied to clipboard')
  }
  const onDelete = (taskId: string): void => {
    qc.setQueryData<TaskRecord[]>(TASKS_KEY, (prev = []) => prev.filter((t) => t.id !== taskId))
    toast.info('Message removed from view')
  }

  if (tasks.length === 0) {
    return (
      <Conversation className="flex-1">
        <ConversationContent>
          <ConversationEmptyState
            description="Send a message to start the conversation."
            icon={<MessagesSquare aria-hidden="true" className="size-6 opacity-60" />}
            title="No messages yet"
          />
        </ConversationContent>
      </Conversation>
    )
  }

  const last = ordered[ordered.length - 1]
  const busy = last.status === 'running' || last.status === 'pending'
  const usage = last.used

  const renderSegment = (seg: Segment): React.JSX.Element => {
    if (seg.kind === 'user') {
      return (
        <Message className="group" from="user" key={seg.key}>
          <MessageContent>
            <span className="whitespace-pre-wrap">{seg.text}</span>
          </MessageContent>
          <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100">
            <MessageAction label="Copy" onClick={() => onCopy(seg.text)} tooltip="Copy message">
              <Copy className="size-3.5" />
            </MessageAction>
            <MessageAction label="Delete" onClick={() => onDelete(seg.taskId)} tooltip="Delete message">
              <Trash2 className="size-3.5" />
            </MessageAction>
          </MessageActions>
        </Message>
      )
    }
    if (seg.kind === 'assistant') {
      return (
        <Message className="group" from="assistant" key={seg.key}>
          <MessageContent>
            <MessageResponse>{seg.text}</MessageResponse>
          </MessageContent>
          <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100">
            <MessageAction label="Copy" onClick={() => onCopy(seg.text)} tooltip="Copy message">
              <Copy className="size-3.5" />
            </MessageAction>
            <MessageAction label="Delete" onClick={() => onDelete(seg.taskId)} tooltip="Delete message">
              <Trash2 className="size-3.5" />
            </MessageAction>
          </MessageActions>
        </Message>
      )
    }
    if (seg.kind === 'tool') {
      return (
        <Tool key={seg.key}>
          <ToolHeader state={toolState(seg.ok)} title={seg.tool} type={`tool-${seg.tool}`} />
          <ToolContent>
            <ToolInput input={seg.input} />
            <ToolOutput
              errorText={seg.ok === false ? (seg.output ?? '') : undefined}
              output={seg.ok === false ? undefined : seg.output}
            />
          </ToolContent>
        </Tool>
      )
    }
    // 'event' and 'error' both render as a compact muted details row.
    const label = seg.label
    return (
      <details
        className="group rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-xs transition-all hover:border-border hover:bg-muted/40"
        key={seg.key}
      >
        <summary className="flex cursor-pointer select-none items-center gap-2 font-mono text-[11px] text-muted-foreground/80 hover:text-muted-foreground">
          <ChevronRight className="size-3.5 transition-transform duration-200 group-open:rotate-90" />
          <span className="font-semibold uppercase tracking-wider">{label}</span>
        </summary>
        <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background/50 p-3 font-mono text-[11px] text-muted-foreground leading-relaxed ring-1 ring-border/30">
          {seg.detail}
        </pre>
      </details>
    )
  }

  return (
    <Conversation className="flex-1">
      <ConversationContent className="mx-auto max-w-3xl">
        {ordered.flatMap((t) => taskSegments(t).map(renderSegment))}
        {busy && (
          <div className="flex animate-pulse items-center gap-3 px-1 text-muted-foreground text-sm">
            <Spinner className="size-4 text-primary" />
            <span className="font-medium">{last.status === 'pending' ? 'Queued…' : 'Swarm is thinking…'}</span>
            {usage && <span className="text-xs opacity-60">· {formatUsage(usage)}</span>}
          </div>
        )}
        {!busy && usage && (
          <div className="flex items-center gap-2 border-border/30 border-t px-1 pt-4 text-muted-foreground text-xs opacity-60">
            <div className="size-1 rounded-full bg-border" />
            {formatUsage(usage)}
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (If `ToolHeader`'s `type` rejects the template literal, cast as needed: `type={\`tool-${seg.tool}\` as `tool-${string}`}` — but the plain template should satisfy `tool-${string}`.)

- [ ] **Step 3: Commit**

```bash
npx biome check --write src/renderer/src/components/conversation-thread.tsx
git add src/renderer/src/components/conversation-thread.tsx
git commit -m "feat(ui): render conversation via ai-elements (streamdown + tool cards + stick-to-bottom)"
```

---

### Task 4: Rewrite `ChatInput` as a `PromptInput` wrapper

**Files:**
- Modify (full rewrite): `src/renderer/src/components/chat-input.tsx`

A thin composer over `PromptInput`: textarea + footer with a disabled attach button, the model `PromptInputSelect`, and `PromptInputSubmit` driven by `status`/`onStop`.

- [ ] **Step 1: Replace the file contents**

Overwrite `src/renderer/src/components/chat-input.tsx` with:

```tsx
import type { ChatStatus } from 'ai'
import { Paperclip } from 'lucide-react'
import { useMemo } from 'react'

import type { ProviderId, ProvidersStateView } from '@shared/types/provider'

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
} from '@/components/ai-elements/prompt-input'
import { useProviders } from '@/hooks/use-providers'

type Props = {
  onSubmit: (goal: string) => void | Promise<void>
  disabled?: boolean
  status?: ChatStatus
  onStop?: () => void
}

type ModelOption = { providerId: ProviderId; modelId: string; key: string }

const PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'openai', 'custom'] as const

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

export function ChatInput({ onSubmit, disabled, status, onStop }: Props): React.JSX.Element {
  const { state } = useProviders()
  const options = useMemo(() => buildModelOptions(state), [state])
  const currentKey =
    state.active && state.providers[state.active] ? `${state.active}::${state.providers[state.active]!.model}` : ''

  const handleSubmit = async (message: PromptInputMessage): Promise<void> => {
    if (disabled) return
    const goal = message.text.trim()
    if (!goal) return
    await onSubmit(goal)
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
      <PromptInput className="mx-auto max-w-3xl" onSubmit={handleSubmit}>
        <PromptInputBody>
          <PromptInputTextarea disabled={disabled} placeholder="Message the swarm…" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputButton disabled tooltip="Attachments — coming soon">
              <Paperclip className="size-4" />
            </PromptInputButton>
            {options.length > 0 && (
              <PromptInputSelect onValueChange={(v) => void onPickModel(v)} value={currentKey}>
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

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If `PromptInputSelect`'s `value`/`onValueChange` props mismatch (it wraps shadcn `Select`), check `src/renderer/src/components/ui/select.tsx` for the exact prop names and adjust to match (e.g. `defaultValue`/`onValueChange`). The base-nova `Select` uses `value` + `onValueChange`.

- [ ] **Step 3: Commit**

```bash
npx biome check --write src/renderer/src/components/chat-input.tsx
git add src/renderer/src/components/chat-input.tsx
git commit -m "feat(ui): rebuild composer on ai-elements PromptInput (model select + stop)"
```

---

### Task 5: Wire the new components in `TasksView`

**Files:**
- Modify: `src/renderer/src/components/views/tasks-view.tsx` (the `<ChatInput>` usage)

`ChatInput` no longer takes `running`; it takes `status: ChatStatus` and `onStop`. Derive `status` from `activeTask`.

- [ ] **Step 1: Update the `ChatInput` usage**

In `src/renderer/src/components/views/tasks-view.tsx`, the current usage is:

```tsx
        <ChatInput
          disabled={!ready}
          onStop={() => {
            if (activeTask) cancelTask.mutate({ sessionId: activeTask.sessionId, taskId: activeTask.id })
          }}
          onSubmit={async (g) => {
            if (!ready) return
            await submitGoal.mutateAsync(g)
          }}
          running={!!activeTask}
        />
```

Replace it with:

```tsx
        <ChatInput
          disabled={!ready}
          onStop={() => {
            if (activeTask) cancelTask.mutate({ sessionId: activeTask.sessionId, taskId: activeTask.id })
          }}
          onSubmit={async (g) => {
            if (!ready) return
            await submitGoal.mutateAsync(g)
          }}
          status={activeTask ? (activeTask.status === 'pending' ? 'submitted' : 'streaming') : 'ready'}
        />
```

(`activeTask` and `cancelTask` are already declared in this file from the Stop-button feature.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all PASS (reducer and other tests unchanged; new `task-segments` tests included).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: typecheck + `electron-vite build` complete with no errors.

- [ ] **Step 5: Commit**

```bash
npx biome check --write src/renderer/src/components/views/tasks-view.tsx
git add src/renderer/src/components/views/tasks-view.tsx
git commit -m "feat(ui): drive composer status/stop from the active task"
```

---

### Task 6: Remove the misplaced install and dead code

**Files:**
- Delete: `@/` (stray root dir), `components.json` (root), `src/components/` (the original mis-targeted ai-elements drop)

Only run this after Tasks 1–5 are green (the chosen files are now ported under `src/renderer/src/components/ai-elements/`).

- [ ] **Step 1: Confirm these are untracked / safe to remove**

Run: `git status --short -- '@/' components.json src/components`
Expected: each shows `??` (untracked). If any is tracked, STOP and report.

- [ ] **Step 2: Remove them**

```bash
cd /Users/gaozimeng/Learn/macOS/SwarmAgents
rm -rf '@' components.json src/components
```

- [ ] **Step 3: Typecheck + build to confirm nothing referenced them**

Run: `npm run typecheck && npm run build`
Expected: PASS. (The renderer imports only from `@/components/ai-elements/*`, which resolves to `src/renderer/src/components/ai-elements/*` — not the deleted `src/components/`.)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove misplaced ai-elements install (@/, components.json, src/components)"
```

---

### Task 7: Manual verification

**Files:** none (verification only).

- [ ] **Step 1: Launch the app**

Run `pnpm dev` (human path; the headless driver can't hold the window in this environment). 

- [ ] **Step 2: Verify the composer**

- The composer renders as the ai-elements `PromptInput` (textarea + footer).
- A disabled paperclip "Attachments — coming soon" button is present.
- The model select shows the active model and switching it changes the active provider/model.
- Typing + Enter submits; Shift+Enter adds a newline; IME composition does not submit early.

- [ ] **Step 3: Verify the transcript**

- Send a prompt that returns markdown including a fenced code block and some CJK text → assistant text renders via streamdown (syntax-highlighted code, correct CJK).
- A tool call renders as a collapsible Tool card (name + status badge; Parameters + Result inside).
- The list sticks to the bottom as output streams; scrolling up reveals the scroll-to-bottom button.

- [ ] **Step 4: Verify stop**

- While a run is active, the submit button shows the Stop (square) icon; clicking it cancels the run and the transcript shows a "stopped" row (not "error").

---

## Notes

- Backend is untouched (Phase 1 is renderer-only). `submitGoal` still takes a string; attachments are deferred to Phase 2.
- `ai@6` remains as a type-only dependency (`ChatStatus`, `UIMessage`, `ToolUIPart` used by ported components).
- `PlanPanel` is unchanged; `update_plan` tool events remain suppressed from the transcript (handled in `taskSegments`).
- The old `ChatInput`/`ConversationThread` raw-div implementations are fully replaced by the rewrites in Tasks 3–4; the uncommitted composer padding tweak is thereby superseded.
