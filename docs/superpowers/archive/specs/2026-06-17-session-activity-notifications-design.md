# Session Activity Notifications — Design

Date: 2026-06-17

## Problem

Work happens in sessions other than the one the user is currently viewing —
most notably cron-triggered tasks (`fire → manager.submitGoal`), but also any
background task activity. Today nothing surfaces this: events stream into the
renderer cache silently, so the user has no signal that a background session
produced a new task, finished one, or now needs their input.

## Goal

When a session that is **not currently open** has activity:

1. Pop a toast for milestone events, with a "查看" button that jumps to that
   session.
2. Mark that session with an unread dot in the session list; clear it when the
   user opens the session.

Backend is untouched — this reuses the existing event-push pipeline
(service `broadcaster` → main `webContents.send('swarm:event')` → preload
`subscribeEvents` → `use-events-subscription`).

## Triggers (decided)

- **Toast**: fires for a non-active session on these milestone events only —
  `task.created`, `task.complete`, `task.ask`, `task.permission_request`.
  Streaming noise (`task.progress`, `task.usage`, `task.tool_call`,
  `task.plan`, `task.dispatched`, …) never toasts.
- **Unread dot**: any `task.*` event carrying a `sessionId` for a non-active
  session marks it unread. Opening the session clears it.

"Non-active" = `e.sessionId !== useSessionsStore.getState().selectedSessionId`.

## Components

### 1. Sessions store (`stores/sessions.ts`) — client-side unread state

Add unread tracking. Not persisted (resets on app restart — YAGNI; the dot is
a "since you last looked" hint, not durable state).

- `unread: Record<string, true>` — new field.
- `markUnread(id: string)`: set `unread[id] = true`, but only when
  `id !== selectedSessionId` (never mark the session you're looking at).
- `select(id)`: existing action, extended to also delete `unread[id]` when
  `id` is non-null. Because the route component
  (`routes/session.$sessionId.tsx`) calls `select(sessionId)` on mount,
  opening or switching to a session clears its dot automatically — no extra
  wiring at the call sites.

### 2. Event handler (`hooks/use-events-subscription.ts`) — the only logic hub

All service events already flow through this subscription. Extend the callback:

```
const sel = useSessionsStore.getState().selectedSessionId
if ('sessionId' in e && e.sessionId && e.sessionId !== sel) {
  useSessionsStore.getState().markUnread(e.sessionId)
  if (TOAST_KINDS.has(e.kind)) notifySessionActivity(e, navigate)
}
```

- `TOAST_KINDS = { 'task.created', 'task.complete', 'task.ask', 'task.permission_request' }`.
- Reads `selectedSessionId` imperatively via `getState()` (non-reactive) so the
  subscription does not re-bind on every selection change.
- `navigate` comes from the router (`useNavigate()`), captured by the hook and
  used inside the toast action.

### 3. Toast helper (`notifySessionActivity`, inline in the hook or a small lib)

Per-kind Chinese copy + a single "查看" action button:

- `task.created` → "「{title}」开始了新任务"
- `task.complete` → "「{title}」任务已完成"
- `task.ask` / `task.permission_request` → "「{title}」需要你的回复"

- `title` resolved from `useSessionsStore.getState().sessions` by `sessionId`,
  falling back to "Untitled chat".
- Toast id = `activity-${sessionId}` so a newer milestone for the same session
  replaces the previous toast instead of stacking.
- Action `onClick`: `navigate({ to: '/session/$sessionId', params: { sessionId } })`.
  Navigation drives the route → `select(sessionId)` → unread cleared.

### 4. Unread dot UI (`components/session-list.tsx`)

The list item button is already `relative`. Add a small dot at the top-left,
shown only when unread and not currently selected:

```tsx
{isUnread && !isSelected && (
  <span aria-label="Unread activity"
        className="absolute top-1 left-1 size-1.5 rounded-full bg-primary" />
)}
```

Read unread via `useSessionsStore((s) => s.unread)`. Coexists with the existing
selected accent bar, running spinner, and awaiting amber dot (the unread dot is
cleared the moment the session becomes selected, so it never overlaps the
selected state).

## Data flow

```
service event (cron task or any background task)
  → broadcaster → main webContents.send('swarm:event')
  → preload subscribeEvents
  → use-events-subscription callback
       ├─ applyEvent(...)                       (existing)
       ├─ markUnread(sessionId) if not active   (new)
       └─ toast(...) if milestone & not active  (new)
  → user clicks "查看" → navigate → select(sessionId) → unread cleared
```

## Testing

- **Store** (`stores/sessions.test.ts`): `markUnread(id)` sets the flag;
  `markUnread(selectedId)` is a no-op; `select(id)` clears `unread[id]`.
- **Event handler** (`hooks/use-events-subscription` test, mocking `sonner`
  and `useNavigate`):
  - `task.created` for a non-active session → `toast` called once + session
    marked unread.
  - same event for the **active** session → no toast, not marked unread.
  - `task.progress` for a non-active session → marked unread, **no** toast.

## Scope / files touched

- `src/renderer/src/stores/sessions.ts` + test
- `src/renderer/src/hooks/use-events-subscription.ts` (+ test if absent)
- `src/renderer/src/components/session-list.tsx`

No backend, IPC, or shared-type changes. No persistence.

## Non-goals (YAGNI)

- Unread **counts** (just a boolean dot).
- Persisting unread across restarts.
- OS-level / native notifications (in-app sonner toast only).
- Per-event-type toast customization beyond the four milestones.
