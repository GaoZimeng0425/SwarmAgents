# Providers Settings + Keychain — Design

Design spec — 2026-05-25
Parent: [2026-05-23-swarm-agents-design.md](./2026-05-23-swarm-agents-design.md) (§4.3, §4.4, §5.1, §5.5)
Status: approved (pending implementation plan)

---

## 0. Context

The parent spec describes a multi-agent Mac automation app whose workers call hosted LLMs. Today the only key path is `process.env.ANTHROPIC_API_KEY`, and `src/worker/handler.ts:9-10` silently falls back to a simulator when the env var is missing — the most common failure mode is "I ran the app and nothing happened." There is no UI to add a key, no persistence, no provider abstraction.

This block delivers the first end-to-end path from **UI input → encrypted on-disk store → worker dispatch** for provider credentials. After it ships, configuring a key from Settings is sufficient to run a real task; the env-var route disappears.

It deliberately does **not** ship the onboarding wizard (parent §5.5) — that block depends on Screen Recording / Accessibility permission flows and is sequenced separately.

### Parent-spec deviations recorded here

- **Storage mechanism**: parent §4.4 says `keytar`. This block uses Electron's built-in `safeStorage` instead. `keytar` is archived, requires native rebuilds against each Electron version, and persists secrets *into* the system Keychain even after the app is uninstalled. `safeStorage` keeps a per-app master key in Keychain but stores the ciphertext under the app's user-data directory, so uninstalling the app drops the secrets with it. Both still rely on the macOS Keychain for protection; the safety property parent §4.4 wanted is preserved.
- **LLM SDK**: parent §4.3 specifies `@ai-sdk/*` (Vercel AI SDK). Current code uses `@earendil-works/pi-ai`'s `getModel`, which reads `ANTHROPIC_API_KEY` from process env. Whether to keep `pi-ai` or migrate to `@ai-sdk/*` depends on whether `pi-ai.getModel` accepts an `apiKey` option. This is a **plan-phase spike**, not a design fork; the IPC contract here is SDK-agnostic.

---

## 1. Scope

### In scope
- Settings → Providers tab (first tab): per-provider key input, model dropdown, Test button, Clear button, global "Active provider" radio
- Encrypted at-rest store backed by `safeStorage`
- Main-side service exposing typed RPC + events to renderer
- Extension of `task.assign` IPC to carry `{ providerId, model, apiKey }` to workers
- Removal of `process.env.ANTHROPIC_API_KEY` from the worker code path
- Main-window banner + disabled task-creation affordance when no active key is configured
- Two providers: `anthropic`, `openai`

### Out of scope (sequenced to later blocks)
| Item | Belongs to |
|---|---|
| Onboarding wizard (Screen Recording + Accessibility + first key) | Onboarding block |
| Settings → MCP servers tab | MCP Registry block |
| Settings → Budgets & Risk defaults tab | Budgets/Risk block |
| Local provider (Ollama) | Future provider block |
| Per-task provider override / Orchestrator-chosen model | Orchestrator block |
| Cluster Overview UI / real "Create task" surface | Cluster Overview block |
| Migration of `pi-ai` → `@ai-sdk/*` (decided by plan-phase spike) | This block's plan, if needed |
| Settings tabs General / Permissions / About content | Their respective blocks |

---

## 2. Decisions (forks resolved during brainstorming)

| # | Fork | Decision | Why |
|---|---|---|---|
| D1 | Storage backend | `safeStorage` (not `keytar`) | `keytar` archived; `safeStorage` is the Electron-supported path with the same Keychain-backed protection and no native module |
| D2 | env-var fallback | Removed | Single trust path; eliminates the silent-simulator failure mode |
| D3 | Provider selection model | Single global "active" provider | Smallest contract; per-task override deferred to Orchestrator block |
| D4 | Model selection | Hardcoded whitelist via dropdown per provider | Matches parent §5.1 ("keys + model selection") without typo risk |
| D5 | Test connection | Manual `[Test]` button (not auto on Save) | Doesn't burn API quota on every Save; gives users an explicit diagnostic |
| D6 | Settings tab placement | Add `Providers` as first tab; leave General/Permissions/About in place | Existing tabs are empty shells but already shipped; full reshuffle is a different block |
| D7 | No-key gate in main window | Inline banner + disabled task affordance | Until the onboarding wizard ships, this is the minimum gate that prevents the "I ran the app and nothing happened" failure mode |
| D8 | simulator dev affordance | Kept, but only under `SWARM_USE_SIMULATOR=1` | Tests / contributors without an API key still have a runnable path |

---

## 3. Data model and storage

### 3.1 File layout (macOS)

```
~/Library/Application Support/swarm-agents/
  providers.enc          # safeStorage.encryptString(JSON.stringify(state))
```

- One file. Decrypted once into memory at main-process boot.
- Writes go through `fs.writeFile(tmp) + rename(tmp, providers.enc)` for atomicity.
- Renderer never receives the file path.

### 3.2 Schemas (Zod, in `src/shared/types/provider.ts`)

```ts
export const ProviderId = z.enum(['anthropic', 'openai'])
export type ProviderId = z.infer<typeof ProviderId>

export const AnthropicModel = z.enum([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
])
export const OpenAIModel = z.enum([
  'gpt-4o',
  'gpt-4o-mini',
  'o1',
  'o1-mini',
])

// On-disk shape — NEVER crosses an IPC boundary to the renderer.
export const ProvidersStateOnDisk = z.object({
  version: z.literal(1),
  active: ProviderId.nullable(),
  providers: z.object({
    anthropic: z
      .object({ model: AnthropicModel, apiKey: z.string().min(1) })
      .nullable(),
    openai: z
      .object({ model: OpenAIModel, apiKey: z.string().min(1) })
      .nullable(),
  }),
})

// Renderer-visible projection — key replaced by hasKey.
export const ProvidersStateView = z.object({
  active: ProviderId.nullable(),
  providers: z.object({
    anthropic: z
      .object({ model: AnthropicModel, hasKey: z.boolean() })
      .nullable(),
    openai: z
      .object({ model: OpenAIModel, hasKey: z.boolean() })
      .nullable(),
  }),
})
```

### 3.3 Defaults and recovery

- File missing → in-memory state `{ version: 1, active: null, providers: { anthropic: null, openai: null } }`.
- `decryptString` throws (machine moved / Keychain reset / corruption) → in-memory state defaults; old `providers.enc` **is not deleted**; a one-shot `providers:decryptFailed` event fires to renderer; UI surfaces an alert. Next successful `setKey` atomically overwrites the file.
- Schema validation after decrypt fails (corrupted JSON / future-version on rollback) → same handling as decrypt failure.
- `safeStorage.isEncryptionAvailable() === false` (rare; mainly Linux without libsecret) → main shows a native fatal dialog and quits. Belt-and-suspenders for a macOS-only spec.

### 3.4 Module layout

```
src/main/providers/
  store.ts        # safeStorage + atomic file IO
  service.ts      # business logic: read / setKey / setActive / setModel / clearKey / test
  ipc.ts          # ipcMain handlers; zod validation at the boundary
  redact.ts       # toView(state) → ProvidersStateView
  index.ts        # init() — wire from app.whenReady
```

---

## 4. IPC contract

### 4.1 Renderer → Main (RPC)

Exposed on `window.swarm.providers.*` via contextBridge:

```ts
type ProvidersBridge = {
  get(): Promise<ProvidersStateView>
  setKey(p: ProviderId, key: string): Promise<{ ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }>
  clearKey(p: ProviderId): Promise<{ ok: true } | { ok: false; code: 'persist_failed'; message: string }>
  setModel(p: ProviderId, model: string): Promise<{ ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }>
  setActive(p: ProviderId | null): Promise<{ ok: true } | { ok: false; code: 'persist_failed'; message: string }>
  test(p: ProviderId): Promise<
    | { ok: true; latencyMs: number }
    | { ok: false; code: 'no_key' | 'unauthorized' | 'rate_limited' | 'network' | 'unknown'; message: string }
  >
}
```

Invariants:
- `get()` returns the View — never the on-disk shape.
- Main re-validates every payload with Zod regardless of preload typing.
- Successful writes are persisted before returning `{ ok: true }`. In-memory state and disk stay consistent: if persist fails, in-memory state does not change.
- `setKey`'s `key` argument is rejected if it is empty, longer than 4096 chars, or contains `\n` / `\r` (catches paste-with-newline mistakes).
- `setModel` validates `model` against the provider's enum.

### 4.2 Main → Renderer (events)

```ts
type ProvidersEvents = {
  onStateChanged(cb: (s: ProvidersStateView) => void): () => void
  onDecryptFailed(cb: () => void): () => void   // fires at most once per boot, only if decrypt failed
}
```

- Any successful `set*` / `clearKey` broadcasts `stateChanged` to all `BrowserWindow`s (main + Settings) so both stay in sync.
- Main window's "ready" flag is derived locally: `state.active != null && state.providers[state.active]?.hasKey === true`. No dedicated gate channel.

### 4.3 Main → Worker

Extend `Inbound['task.assign']` in `src/shared/types/ipc.ts`:

```ts
type Inbound =
  | {
      type: 'task.assign'
      task: Task
      promptContext: string
      provider: {
        id: ProviderId
        model: string
        apiKey: string   // lives only in worker process memory; never logged, never persisted
      }
    }
  | ...
```

Dispatch flow:
1. Main task creator reads current `(active, model, apiKey)` from the provider service.
2. `MessagePort.postMessage({ type: 'task.assign', ..., provider })`.
3. Worker's `handleInbound` passes `provider` into `runPiAgent(task, { send, permissionClient, provider })`.
4. `runPiAgent` constructs the model with `provider.apiKey` + `provider.model`. The `process.env.ANTHROPIC_API_KEY` read in `pi-agent/index.ts:30` is removed.

If at dispatch time `active == null` or the active provider has no key, **the task is not dispatched**. Main instead sends `task.error { code: 'no_provider', tier: 'fatal' }` to the renderer. This is a defense-in-depth check; the UI gate (§5.3) should make it unreachable.

`SWARM_USE_SIMULATOR=1` still short-circuits to the simulator in `handler.ts` for dev/test, regardless of provider payload.

### 4.4 `pi-ai.getModel` API shape — plan-phase spike

The plan's first task is a 30-minute spike: does `getModel('anthropic', 'claude-sonnet-4-5')` accept an `apiKey` option?

- If yes → keep `pi-ai`, pass `provider.apiKey` through.
- If no → switch to `@ai-sdk/anthropic`'s `createAnthropic({ apiKey })` and `@ai-sdk/openai`'s `createOpenAI({ apiKey })`, as parent §4.3 originally specified.

Under no circumstances does the worker write to `process.env` at runtime to inject the key — that would create cross-task contamination if a worker is reused.

### 4.5 Logging and redaction

- Main and worker `pino` loggers configured with `redact: ['provider.apiKey', 'apiKey', '*.key', '*.apiKey']`.
- Any payload persisted to task history (parent §6) is run through a redaction pass before write.
- `provider.apiKey` is excluded from any structured-clone postMessage that crosses to the renderer (it never originates from main → renderer, but assert via a code-level invariant).

---

## 5. UI

### 5.1 Settings tab order

`src/renderer/src/routes-settings/__root.tsx` TABS becomes:

```
[ Providers, General, Permissions, About ]
```

New route file: `src/renderer/src/routes-settings/providers.tsx`. The TanStack route tree regenerates accordingly.

When the Settings window is opened via `window.swarm.openSettings()` from the main-window banner, it should land on `/providers` (route default change). When opened via the menu / `⌘,`, it lands wherever it last was (existing behaviour).

### 5.2 Providers tab layout

```
┌─ Settings ────────────────────────────────────────────┐
│  Providers · General · Permissions · About            │
├───────────────────────────────────────────────────────┤
│                                                       │
│  Active provider   (○ Anthropic)  (○ OpenAI)          │
│                                                       │
│  ──────────────────────────────────────────────────   │
│  Anthropic                                            │
│    API key       [••••••••••••••••••]      [Save]     │
│                  Key set ✓                  [Clear]   │
│    Model         [claude-sonnet-4-5  ▾]               │
│                  [ Test ]      ✓ 142 ms               │
│                                                       │
│  ──────────────────────────────────────────────────   │
│  OpenAI                                               │
│    API key       [                       ]  [Save]    │
│                  Not set                              │
│    Model         [gpt-4o  ▾]                          │
│                  [ Test ]   — set a key first         │
│                                                       │
└───────────────────────────────────────────────────────┘
```

Behaviour:
- **Key field**: `<input type="password">` always; eye toggle (press-and-hold, not latching). Placeholder `••••••••` when `hasKey === true`; input is never pre-filled.
- **`[Save]`** → `providers.setKey()`. On success: input clears, row state becomes `Key set ✓`.
- **`[Clear]`** → confirm via `window.swarm.showConfirm` (native macOS dialog) → `providers.clearKey()`.
- **Active radio** uses base-ui `RadioGroup`. Selecting a provider with no key is allowed (state is permitted; the main-window gate is what enforces "ready to dispatch"). Switching active calls `providers.setActive()` immediately; no Save.
- **Model dropdown** uses base-ui `Select`. Changing the value calls `providers.setModel()` immediately; no Save. Options come from the hardcoded enum.
- **`[Test]`** is disabled when the row has no key, with hint `set a key first`. State machine: `idle → testing → ok(latency) | error(code+msg)`.
  - `unauthorized` → red `Invalid key`
  - `rate_limited` → amber `Rate-limited (key is valid)`
  - `network` → grey `Network error`
  - `unknown` → grey with status code in tooltip
- **Concurrency**: within a single provider row, Save / Test are mutually exclusive. Across providers they run independently.
- **Cursor / hover** follows the `native-feel` skill: no `cursor:pointer` on rows; default `cursor` on buttons; no hover translations.

### 5.3 Main window — no-key banner and gate

Main window mounts a derived flag:

```ts
const ready = state.active !== null && state.providers[state.active]?.hasKey === true
```

When `!ready`:
- Inline alert banner at the top of the window (not a toast): `⚠ No API key configured.` with an action `[Open Settings]` calling `window.swarm.openSettings()` (the existing B.18 IPC).
- Any "create task" affordance receives `aria-disabled` + `disabled` + tooltip "Configure a provider to start tasks."

When `ready`: banner hidden.

> Today the main window does not yet have a real Create-task surface (Cluster Overview is a later block). This block delivers: (a) the banner; (b) the derived `ready` flag exported from a single hook so future task-creation UI can consume it; (c) any current demo/temporary task entry point in the renderer wired through the same flag.

### 5.4 `safeStorage` unavailable / decrypt failure UI

- Decrypt failed at boot → top of Providers tab: inline alert "Saved keys could not be decrypted on this machine. Re-enter them to continue." (dismissible — but next decrypt-fail boot it returns).
- `isEncryptionAvailable() === false` → handled at main-process boot with `dialog.showMessageBox` and app quit; the renderer never starts.

---

## 6. Errors, testing, acceptance

### 6.1 Error matrix

| Trigger | Surface | Recovery |
|---|---|---|
| Main boot: `isEncryptionAvailable() === false` | Native fatal dialog → quit | None |
| Main boot: `decryptString` throws | `providers:decryptFailed` event + Providers-tab alert | User re-enters key; next successful `setKey` overwrites file |
| Main boot: schema validation post-decrypt fails | Same as decrypt failure | Same |
| `setKey/setModel/setActive/clearKey` write to disk fails | RPC returns `{ ok: false, code: 'persist_failed' }` | UI inline error; in-memory state unchanged |
| `setKey` validation fails (empty / too long / contains newline) | RPC returns `{ ok: false, code: 'invalid' }` | UI inline error |
| `test()` HTTP 401/403 | `{ ok: false, code: 'unauthorized' }` | UI red |
| `test()` HTTP 429 | `{ ok: false, code: 'rate_limited' }` | UI amber + "Key is valid" |
| `test()` fetch throws / 10 s timeout | `{ ok: false, code: 'network' }` | UI grey |
| `test()` other non-2xx | `{ ok: false, code: 'unknown' }` with status code | UI grey |
| Worker dispatch: active/key missing despite UI gate | `task.error { code: 'no_provider', tier: 'fatal' }` to renderer | UI shows error; not silently routed to simulator |
| Worker `task.assign.provider.apiKey` empty (should not happen) | `task.error { code: 'invalid_dispatch', tier: 'fatal' }` | Same |

### 6.2 Test plan

**Unit (vitest)**
- `store.ts`: encrypt → write → read → decrypt round-trip with mocked `safeStorage` (identity in test) and a temp dir.
- `store.ts`: on decrypt failure the existing file is **not** deleted (assert file still on disk after the failure path runs).
- `service.ts`: every state transition (`setKey`, `clearKey`, `setActive`, `setModel`); invariant — in-memory state never advances past a failed persist.
- `service.ts`: validation rejection paths (empty key, oversize key, newline-containing key, invalid model id).
- `redact.ts`: property-walk assertion that no `apiKey` field survives `toView`.
- `ipc.ts`: every RPC re-validates payload with Zod; invalid payloads return structured errors.
- Logger redaction: log a record containing `apiKey` / `provider.apiKey`, assert the serialised output does not contain the value.

**Worker handler**
- `handler.ts`: `task.assign` carrying a `provider` does **not** route to simulator; passes `provider` through to `runPiAgent` (mocked).
- `handler.ts`: `SWARM_USE_SIMULATOR=1` continues to route to simulator regardless of `provider`.
- `pi-agent/index.ts`: no read of `process.env.ANTHROPIC_API_KEY` (assert by mocking `process.env` empty and verifying the code path uses `provider.apiKey`).

**Contract**
- `ProvidersStateOnDisk` ↔ `ProvidersStateView` projection is total and irreversible (no key in view).
- IPC schemas: payloads round-trip cleanly under Zod parse on both sides for every RPC.

**Manual verification checklist (part of the PR description)**

1. Launch app with no `providers.enc` → main window shows banner; task entry disabled.
2. Open Settings via banner → lands on Providers tab.
3. Enter Anthropic key → Save → shows `Key set ✓`. Switch Active → Anthropic.
4. Main window banner clears; task entry enabled.
5. Click Test → shows latency. Then enter an invalid key, Test → shows `Invalid key` (red).
6. Quit and relaunch → key persists; main window comes up `ready`.
7. Click Clear on Anthropic row → confirm → row shows `Not set`. Banner reappears.
8. Corrupt `providers.enc` (manually flip a byte) → relaunch → Providers-tab alert appears, state is empty; re-entering keys recovers.

No automated E2E in this block (no Electron E2E infrastructure exists yet; deferred).

### 6.3 Acceptance criteria

Block is done when **all** of these hold:

1. Settings has a `Providers` tab in the first position; it can add / change / clear keys for both Anthropic and OpenAI, select a model, switch the active provider, and run a Test.
2. All keys are persisted via `safeStorage` to `providers.enc`. The renderer never receives a raw key.
3. The main window derives `ready` from `(active, hasKey)`; non-ready shows the banner and disables task-creation affordances.
4. Workers receive `provider` via the extended `task.assign` payload. The `process.env.ANTHROPIC_API_KEY` code path is gone.
5. `SWARM_USE_SIMULATOR=1` still forces the simulator. Without it, a missing key produces a `no_provider` fatal error, never a silent simulator fall-through.
6. All unit tests above pass; manual verification checklist passes on a clean macOS install.
