# Session-as-Route Design

**Date:** 2026-06-16
**Status:** Approved (brainstorming) — pending implementation plan

## Goal

Make each session a distinct route (`#/session/<ulid>`) so the existing
forward/back navigation arrows traverse session history. Today session
selection lives only in Zustand (`selectedSessionId`) and never touches the
router, so the back/forward arrows in `app-sidebar.tsx` can only move between
`/`, `/skills`, and settings — switching sessions produces no history entry.

## Current state

- Renderer uses TanStack Router with `createHashHistory()`
  (`src/renderer/src/entries/main.tsx`).
- `routes/index.tsx` (`/`) renders `TasksView`.
- Forward/back arrows already exist and are wired to
  `router.history.back()` / `router.history.forward()` (`app-sidebar.tsx`).
- Session selection is in-memory Zustand state: `useSessionsStore`
  (`stores/sessions.ts`), set via `select(id)`.
- `session-list.tsx` `onSelect` does `select(id) + hydrateSession + navigate({to:'/'})`;
  `onNew` does `createSession() + select + navigate({to:'/'})`.
- `TasksView` reads `selectedSessionId` from the store and filters tasks,
  permission prompts, and ask prompts by it.

## Approach: URL-driven, store as mirror

The route param is the single source of truth. The session route component
syncs the param into the existing Zustand `selectedSessionId` via an effect, so
**every existing consumer that reads `selectedSessionId` stays unchanged.**

Rejected alternatives:
- **Pure route params** (delete `selectedSessionId`, read `useParams()`
  everywhere): cleanest conceptually but touches every consumer and breaks
  consumers outside the route subtree. Higher regression risk.
- **Store-as-source, sync URL from store**: bidirectional sync, race-prone;
  a strictly worse version of the chosen approach.

## Decisions (boundaries)

1. **Startup / root `/`**: always show an empty state. No auto-restore of the
   last session. Empty state appears whenever the URL has no session.
2. **Delete the currently-open session**: navigate to the most-recently-active
   remaining session (by `lastActiveAt`); if none remain, navigate to `/`.
3. **URL form**: ULID directly — `#/session/01J...`. No short-code mapping.
4. **Empty state does NOT implicitly create a session.** Sessions are created
   only via the "New chat" button (unchanged from today). The composer requires
   a selected session, so it is unavailable on `/`.
5. **Clicking the already-open session is a no-op** — TanStack Router does not
   push a duplicate history entry for the same path.

## Components

### Routes

- `routes/index.tsx` (`/`): render a new `EmptyState` component instead of
  `TasksView`. On entry, clear residual selection with `select(null)` so a
  stale session does not render.
- `routes/session.$sessionId.tsx` (`#/session/$sessionId`): render `TasksView`.

### Session route component (sync layer)

```tsx
const { sessionId } = Route.useParams()
useEffect(() => {
  select(sessionId)
  void hydrateSession(qc, sessionId)
}, [sessionId])
// If the session is not found (deleted / stale), navigate({ to: '/' }).
return <TasksView />
```

`TasksView` itself is unchanged — it keeps reading `selectedSessionId` from the
store, which the effect above keeps in sync with the URL.

### `session-list.tsx`

- `onSelect(id)`: replace `select(id) + hydrateSession + navigate({to:'/'})`
  with `navigate({ to: '/session/$sessionId', params: { sessionId: id } })`.
  Selection + hydration move to the route effect.
- `onNew()`: after `createSession()`, `navigate` to the new session's route.
- `confirmDelete()`: after deleting, if the deleted id is the currently-routed
  session, navigate to the most-recently-active remaining session (by
  `lastActiveAt`), or `/` if none remain. Otherwise no navigation.

### Forward/back

No new code. The existing `router.history.back()/forward()` arrows in
`app-sidebar.tsx` traverse session history automatically once session switches
go through `navigate`.

### `EmptyState`

A small welcome panel prompting the user to click "New chat" or pick a session
from the sidebar. Does not create a session and does not render a usable
composer.

## Error handling

- **Unknown / deleted session id in the URL** (e.g. refresh on a stale hash, or
  the session was deleted in another window): the route effect detects the
  missing session after hydration and redirects to `/`.

## Logging

This is renderer-only navigation; follow existing renderer conventions. No new
business-path logging in the service layer is required (session create/delete
already log in `session-manager.ts`).

## Testing

- Unit: `session-list` `onSelect` / `onNew` / `confirmDelete` produce the
  correct `navigate` calls (including the delete-current → most-recent-remaining
  branch and the delete-last → `/` branch).
- Integration (renderer): navigating to `/session/$sessionId` syncs
  `selectedSessionId` and hydrates; navigating to `/` clears selection;
  unknown id redirects to `/`.
