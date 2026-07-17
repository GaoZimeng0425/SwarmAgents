# Renderer-IPC Single-Sourcing (renderer→main leg)

Date: 2026-07-17
Status: approved design, pre-implementation
Predecessor: `2026-07-17-method-table-design.md` (main↔service leg, merged as develop `defa1870`)

## Problem

The renderer→main IPC surface exists as four hand-synchronized copies:

1. `packages/protocol/src/types/ui.ts` — `SwarmBridge` + per-domain bridge types
   (`BilibiliBridge`, `CalendarBridge`, …), hand-written member signatures.
2. `apps/desktop/src/preload/index.ts` — ~150 `ipcRenderer.invoke('<channel>', …)`
   calls implementing those bridges, plus 14 `ipcRenderer.on` event subscriptions.
3. ~139 `ipcMain.handle('<channel>', …)` registrations across 15 main-process files
   (`ipc/swarm-ipc.ts` 43, `bilibili/ipc.ts` 24, `providers/ipc.ts` 16, `gmail/ipc.ts` 14,
   `calendar/ipc.ts` 10, plus mcp-servers / web-search / trending / quick-panel /
   article / weather / budgets / workbench / deep-link / index.ts).
4. `apps/desktop/src/renderer/src/lib/api.ts` — the flat `swarmApi` facade over
   `window.swarm`.

Channel strings, argument tuples, and result types are repeated at each layer with no
compile-time link. Drift symptoms today: `swarm-ipc.ts`'s `dispose()` maintains a
~40-line hand-written `removeHandler` list that must mirror the `handle` list; a typo'd
channel or changed signature surfaces only at runtime.

## Goals

- One type-level source of truth for every renderer→main invoke channel
  (`RendererIpcSignatures`) and every main→renderer event channel
  (`RendererIpcEvents`).
- preload and main both consume the table: a typed `invoke`/`subscribe` pair in
  preload; a typed registrar (`createIpcRegistrar`) + `sendToAllWindows` in main.
  Channel typos, arg mismatches, and result drift become compile errors.
- Pure service passthrough channels reference `ServiceMethodSignatures` (the
  already-merged main↔service table) per entry, so a service signature change
  propagates to this leg automatically.
- `removeHandler` bookkeeping automated by the registrar.
- Zero renderer changes: channel strings, `window.swarm` nesting, and `swarmApi`
  keep their exact shapes.

## Non-Goals

- No channel renames (renderer/preload/main ship in one binary; renaming is churn
  with no compatibility payoff).
- No runtime (zod) validation on this leg: the renderer is same-binary and loads no
  remote content, so it is a trusted boundary. Validation lives at the service
  dispatcher (previous spec), which this leg's calls still pass through.
- No changes to the WS/service leg, `swarmApi`'s flat shape, or `window.swarm`'s
  nested shape.
- No runtime assertion that every table channel has a registered handler.
  Enforcement is one-directional by construction: every `handle()` and `invoke()`
  call site must name a table channel (compile-checked), but registration
  completeness across 15 files is runtime wiring — a missing registration behaves
  exactly as today (Electron's "No handler registered" rejection).

## Design

### 1. Signature tables — new file `packages/protocol/src/renderer-ipc.ts`

Type-only module (no runtime values, no zod). Lives in protocol because the bridge
types it describes (`SwarmBridge` et al.) already live there.

```ts
import type { ServiceMethod, ServiceMethodSignatures } from './service-methods'

// A channel that forwards verbatim to the service: same args, same result.
// Referencing the service table per entry means a service signature change
// propagates here without touching this file.
type Passthrough<M extends ServiceMethod> = ServiceMethodSignatures[M]

export type RendererIpcSignatures = {
  // -- pure passthroughs (channel string ≠ method name is fine; the link is the entry)
  'swarm:listSessions': Passthrough<'listSessions'>
  'swarm:submitPrompt': Passthrough<'submitPrompt'>
  'skills:list': Passthrough<'listSkills'>
  // -- main-transformed channels get their REAL renderer-facing signature
  'swarm:createSession': { args: []; result: { sessionId: string } } // main injects provider
  'swarm:analyzeThread': { args: [AnalyzeThreadInput]; result: AnalyzeThreadResult }
  'skills:import': {
    args: [{ sourceDir?: string; overwrite?: boolean }?]
    // Mirrors swarm-ipc.ts today: store result, or the dialog-cancelled branch,
    // or the name-clash branch echoing sourceDir for the overwrite retry.
    result: SkillMutationResult | { ok: false; code: 'cancelled' | 'exists'; message: string; sourceDir?: string }
  }
  // -- main-owned domains (bilibili/gmail/calendar/providers/…) written out in full
  'bilibili:login': { args: []; result: BiliLoginStatus }
  // … all ~150 channels
}
export type RendererIpcChannel = keyof RendererIpcSignatures

export type RendererIpcEvents = {
  'swarm:event': UIEvent
  'mcp:status': McpServerStatus[]
  'system:accentChange': { hex: string }
  'swarm:navigate': { sessionId?: string; route?: string }
  'bilibili:transcribeProgress': BiliTranscribeProgress
  // … all 14 event channels (each domain's STATE_CHANGED const value moves here)
}
export type RendererIpcEventChannel = keyof RendererIpcEvents
```

Rules:
- Channel strings copied verbatim from today's code (the implementation plan's first
  task is an exhaustive inventory: grep every `ipcMain.handle` / `ipcRenderer.invoke` /
  `ipcRenderer.on` / `webContents.send`, including channels referenced through
  constants, and reconcile the three lists).
- `Passthrough<M>` is used ONLY where the renderer-facing signature is byte-identical
  to the service signature. Any channel where main injects, transforms, or defaults
  (createSession, analyzeThread, article/trending provider injection, skills:import
  dialog flow) gets a hand-written entry with its true renderer-facing signature.
- Signatures must match the CURRENT bridge member types in `types/ui.ts` — this
  refactor pins existing behavior; it does not redesign any API.
- One-way imports: `renderer-ipc.ts` imports from `./service-methods` and `./types/*`;
  nothing in `types/*` imports it.

### 2. preload consumption — rewrite internals of `apps/desktop/src/preload/index.ts`

```ts
const invoke = <C extends RendererIpcChannel>(
  channel: C,
  ...args: RendererIpcSignatures[C]['args']
): Promise<RendererIpcSignatures[C]['result']> => ipcRenderer.invoke(channel, ...args)

const subscribe = <C extends RendererIpcEventChannel>(
  channel: C,
  cb: (payload: RendererIpcEvents[C]) => void
): (() => void) => {
  const listener = (_e: IpcRendererEvent, payload: RendererIpcEvents[C]): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
```

Every bridge member becomes a one-liner through `invoke`/`subscribe`; the nested
`SwarmBridge` object shape and `index.d.ts` declaration are unchanged. Existing
subscription helpers that add behavior (one-shot consumption, payload massaging)
keep that behavior — they just route through `subscribe` for the typed on/off pair.

### 3. main consumption — new file `apps/desktop/src/main/ipc/wire.ts`

```ts
export type TypedIpcHandler<C extends RendererIpcChannel> = (
  e: Electron.IpcMainInvokeEvent,
  ...args: RendererIpcSignatures[C]['args']
) => RendererIpcSignatures[C]['result'] | Promise<RendererIpcSignatures[C]['result']>

// Tracks what it registered; dispose() removes exactly that set. Kills the
// hand-maintained removeHandler lists.
export function createIpcRegistrar(): {
  handle<C extends RendererIpcChannel>(channel: C, fn: TypedIpcHandler<C>): void
  dispose(): void
}

export function sendToAllWindows<C extends RendererIpcEventChannel>(
  channel: C,
  payload: RendererIpcEvents[C]
): void
```

Each of the 15 domain files swaps `ipcMain.handle` → `registrar.handle` (handler
bodies unchanged; signatures now compiler-checked) and replaces its hand-written
"loop all BrowserWindows and send" blocks with `sendToAllWindows`. `swarm-ipc.ts`'s
dispose shrinks to `registrar.dispose()` plus its non-IPC unsubscribes.

`registrar.handle` internally casts once to Electron's untyped handler type — the
same single-documented-cast pattern as the service dispatcher's choke point.

### 4. Migration phasing — one spec, three plans, three worktrees

The invoke table grows **per domain**: typed `invoke` only requires entries for the
channels it is called with, so each plan adds its domains' table entries, switches
those domains' preload members, and migrates those domains' main-side files —
together, in one reviewable unit. (An earlier draft switched the preload wholesale
in Plan 1; per-domain switching supersedes it because it removes the one big-bang
step this spec's own risk section flagged.) The **events table is the exception**:
all 15 event channels land in Plan 1 — it is small, and it lets the preload's
subscription helpers switch to the typed `subscribe` in one pass; event *senders*
still migrate per domain with their files.

- **Plan 1 — mechanism + first domains:** channel inventory (committed as a notes
  doc for Plans 2/3), `RendererIpcSignatures` entries + preload members + main-side
  migration for `ipc/swarm-ipc.ts`, `ipc/article-ipc.ts`, `trending/ipc.ts`,
  `system/deep-link.ts`, `index.ts`'s inline handlers, and `quick-panel/ipc.ts`;
  full `RendererIpcEvents` table + all preload subscriptions switched; `wire.ts`.
  Ends with a `run-desktop` launch smoke test.
- **Plan 2 — heavy domains:** `bilibili/ipc.ts` (24), `providers/ipc.ts` (16),
  `mcp-servers/ipc.ts`, `web-search/ipc.ts`, `budgets/ipc.ts` — table entries +
  preload members + main files per domain.
- **Plan 3 — remaining domains + closure:** `gmail/ipc.ts` (14), `calendar/ipc.ts`
  (10), `weather/ipc.ts`, `workbench/ipc.ts`; then the closure check — a grep gate
  asserting no bare `ipcMain.handle(` / window-loop `webContents.send` remains
  outside `wire.ts`, and no raw `ipcRenderer.invoke(` / `ipcRenderer.on(` remains
  in the preload outside the `invoke`/`subscribe` helpers. Sole exclusion: the
  dev-only `ipcMain.on('ping')` listener in `main/index.ts` uses `on` (not
  `handle`), predates this work, and stays as-is.

Each plan lands on develop independently; the app is fully functional after every
merge (unmigrated domains keep their bare `ipcMain.handle` until their plan).

## Error Handling

Unchanged: a handler throw rejects the renderer's invoke promise with Electron's
serialized error, exactly as today. The registrar adds no catch layer (logging
stays in handler bodies per the project's logging rules).

## Testing

- Type tests in protocol: pin representative `Passthrough` entries (assignability
  both directions against `ServiceMethodSignatures`) and a couple of hand-written
  entries against their bridge-member types in `types/ui.ts`.
- `wire.ts` unit tests: handle/dispose pairing (registered set removed exactly),
  `sendToAllWindows` respects destroyed windows (mock BrowserWindow).
- Per-domain regression: the existing renderer/domain test suites + full typecheck
  after each plan.
- Plan 1 ends with a `run-desktop` smoke test (launch, screenshot, exercise one
  session flow) because preload switches wholesale in that plan.

## Compatibility & Risks

- **Channel strings and bridge shapes are frozen** — the inventory task must prove
  the table matches reality before any consumer switches (149 preload invokes vs
  ~139 handles: the delta is channels registered outside `ipcMain.handle` grep hits
  or handles registered via constants — the inventory reconciles this, and any
  channel found in preload with no main handler is a latent dead call to surface,
  not silently table-ize).
- **Preload switching is per-domain** (see §4), so no single step touches all 150
  call sites; each domain's switch is typechecked against the existing `SwarmBridge`
  member types (transcription errors surface at compile time) and Plan 1 carries a
  `run-desktop` smoke test for the mechanism itself.
- **Event-channel constants** (`STATE_CHANGED` consts per domain) become table keys;
  senders and subscribers must both move in the same plan as their domain.
- `renderer-ipc.ts` is type-only, so it adds zero bytes to any runtime bundle.
