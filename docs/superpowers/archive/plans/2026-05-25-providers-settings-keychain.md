# Providers Settings + Keychain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Providers tab in Settings that stores API keys for Anthropic + OpenAI via Electron `safeStorage`, gates the main window when no key is configured, and dispatches keys to workers through extended `task.assign` IPC — removing the `process.env.ANTHROPIC_API_KEY` code path.

**Architecture:** Single encrypted file `providers.enc` under `app.getPath('userData')` holds `{ active, providers: { anthropic, openai } }`. A main-process service (`src/main/providers/*`) owns reads/writes; renderer talks to it via typed `window.swarm.providers.*` RPC and receives a redacted view (no key bytes). Workers receive `{ providerId, model, apiKey }` via an extended `task.assign` payload at dispatch time. The main window derives a `ready` flag from `(active, hasKey)` and shows an inline banner + disables task entry when not ready.

**Tech Stack:** TypeScript, Electron `safeStorage`, Zod for IPC schema, base-ui React primitives, TanStack Router (hash history) for Settings, vitest, pino logger with redaction.

**Spec:** [`docs/superpowers/specs/2026-05-25-providers-settings-keychain-design.md`](../specs/2026-05-25-providers-settings-keychain-design.md)

---

## File Structure

### New files
- `src/shared/types/provider.ts` — Zod schemas: `ProviderId`, `AnthropicModel`, `OpenAIModel`, `ProvidersStateOnDisk`, `ProvidersStateView`, `ProviderInjection`
- `src/main/providers/redact.ts` — `toView(state)` pure projection
- `src/main/providers/redact.test.ts`
- `src/main/providers/store.ts` — `safeStorage` wrapper + atomic file IO
- `src/main/providers/store.test.ts`
- `src/main/providers/service.ts` — state machine (`init`, `getState`, `setKey`, `clearKey`, `setActive`, `setModel`, `getInjection`)
- `src/main/providers/service.test.ts`
- `src/main/providers/test-connection.ts` — HTTP ping for Anthropic + OpenAI
- `src/main/providers/test-connection.test.ts`
- `src/main/providers/ipc.ts` — `wireProvidersIpc(service)` returning `{ dispose }`
- `src/main/providers/index.ts` — barrel export + `initProviders(app)`
- `src/renderer/src/hooks/use-providers.ts` — subscribes to state + `ready` derived flag
- `src/renderer/src/routes-settings/providers.tsx` — Providers tab UI
- `src/renderer/src/components/views/providers-view.tsx` — extracted UI (route is thin)
- `src/renderer/src/components/no-provider-banner.tsx` — main-window banner

### Modified files
- `src/shared/types/ipc.ts` — extend `InboundSchema['task.assign']` with `provider` field
- `src/shared/types/ui.ts` — extend `SwarmBridge` with `providers` namespace + `openSettings` accepts optional route
- `src/preload/index.ts` — expose `window.swarm.providers.*` + new event subscriptions
- `src/main/index.ts` — init providers service before `createMainWindow`
- `src/main/ipc/swarm-ipc.ts` — wire providers IPC alongside existing handlers
- `src/main/windows/settings-window.ts` — accept optional `initialRoute` param
- `src/main/supervisor/index.ts` — accept `provider` injection in `dispatch`
- `src/worker/index.ts` — no change required (it passes parsed inbound straight through)
- `src/worker/handler.ts` — drop env-var fallback; require provider from `task.assign`
- `src/worker/pi-agent/index.ts` — read key/model from arg, not env (exact form depends on Task 1 spike)
- `src/renderer/src/routes-settings/__root.tsx` — add Providers to TABS at index 0
- `src/renderer/src/entries/main.tsx` — mount NoProviderBanner inside the app shell
- `src/shared/logger.ts` — add `redact` pino config

---

## Task 1: Spike — `@earendil-works/pi-ai` `getModel` apiKey support

**Files:**
- Read-only investigation; outputs documented in: `docs/superpowers/plans/2026-05-25-providers-settings-keychain.md` (this file, append findings under "Spike Results" section at the bottom)

**Why this task is first:** Tasks 13 + 14 hinge on whether `pi-ai`'s `getModel` accepts an `apiKey` option. If it does we keep `pi-ai`; if not we switch to `@ai-sdk/anthropic` + `@ai-sdk/openai`. This affects ~30 lines of `pi-agent/index.ts` and which deps we add to `package.json`.

- [ ] **Step 1: Inspect the pi-ai package types**

Run: `cat node_modules/@earendil-works/pi-ai/package.json | grep -E '"(main|types|exports)"'`
Then: `find node_modules/@earendil-works/pi-ai -name "*.d.ts" -maxdepth 3 | head -20`
Open the .d.ts files reachable from the `exports` map and locate the `getModel` declaration.

Expected: a signature roughly like `getModel(providerId: string, model: string, options?: {...}): LanguageModel`. Look for `apiKey`, `headers`, or `auth` in the options type.

- [ ] **Step 2: Confirm at runtime**

Create a throwaway file `scripts/spike-pi-ai.ts`:

```ts
import { getModel } from '@earendil-works/pi-ai'

// Try passing apiKey in the third arg. If TypeScript rejects, we know.
const m = getModel('anthropic', 'claude-sonnet-4-5', { apiKey: 'test-fake-key' } as never)
console.log('signature accepted at runtime; model type:', typeof m, Object.keys(m as object))
```

Run: `pnpm tsx scripts/spike-pi-ai.ts`
Observe the output (or TypeScript error from the `.d.ts`).

- [ ] **Step 3: Record findings inline in this plan**

Append to the bottom of this file under a new `## Spike Results` heading:

```markdown
## Spike Results

**Date:** YYYY-MM-DD
**Decision:** [ ] keep `pi-ai` / [ ] migrate to `@ai-sdk/*`

**Evidence:**
- `getModel` signature: `<paste from .d.ts>`
- Accepts apiKey option: yes / no
- If no, fallback plan: use `@ai-sdk/anthropic` createAnthropic({ apiKey }) and `@ai-sdk/openai` createOpenAI({ apiKey }) per parent spec §4.3

**Implications for downstream tasks:**
- Task 13 (worker/handler.ts): unchanged either way (just passes provider through)
- Task 14 (worker/pi-agent/index.ts): if migrate, add deps + rewrite model construction
```

- [ ] **Step 4: Clean up and commit the recorded findings only**

```bash
rm scripts/spike-pi-ai.ts
git add docs/superpowers/plans/2026-05-25-providers-settings-keychain.md
git commit -m "docs(plan): record pi-ai spike result for providers block"
```

---

## Task 2: Shared schemas in `src/shared/types/provider.ts`

**Files:**
- Create: `src/shared/types/provider.ts`
- Create: `src/shared/types/provider.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/shared/types/provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  ProviderId,
  AnthropicModel,
  OpenAIModel,
  ProvidersStateOnDisk,
  ProvidersStateView,
  defaultProvidersStateOnDisk,
  ProviderInjection,
} from './provider'

describe('provider schemas', () => {
  it('ProviderId accepts anthropic and openai', () => {
    expect(ProviderId.parse('anthropic')).toBe('anthropic')
    expect(ProviderId.parse('openai')).toBe('openai')
    expect(() => ProviderId.parse('gemini')).toThrow()
  })

  it('AnthropicModel enum covers expected models', () => {
    for (const m of [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
    ]) {
      expect(AnthropicModel.parse(m)).toBe(m)
    }
    expect(() => AnthropicModel.parse('gpt-4o')).toThrow()
  })

  it('OpenAIModel enum covers expected models', () => {
    for (const m of ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini']) {
      expect(OpenAIModel.parse(m)).toBe(m)
    }
    expect(() => OpenAIModel.parse('claude-opus-4-7')).toThrow()
  })

  it('ProvidersStateOnDisk requires version 1', () => {
    const ok = ProvidersStateOnDisk.parse({
      version: 1,
      active: null,
      providers: { anthropic: null, openai: null },
    })
    expect(ok.version).toBe(1)
    expect(() =>
      ProvidersStateOnDisk.parse({
        version: 2,
        active: null,
        providers: { anthropic: null, openai: null },
      }),
    ).toThrow()
  })

  it('ProvidersStateOnDisk rejects empty apiKey', () => {
    expect(() =>
      ProvidersStateOnDisk.parse({
        version: 1,
        active: 'anthropic',
        providers: {
          anthropic: { model: 'claude-sonnet-4-5', apiKey: '' },
          openai: null,
        },
      }),
    ).toThrow()
  })

  it('ProvidersStateView mirrors structure but uses hasKey', () => {
    const v = ProvidersStateView.parse({
      active: 'anthropic',
      providers: {
        anthropic: { model: 'claude-sonnet-4-5', hasKey: true },
        openai: null,
      },
    })
    expect(v.providers.anthropic?.hasKey).toBe(true)
  })

  it('defaultProvidersStateOnDisk returns an empty version-1 state', () => {
    const d = defaultProvidersStateOnDisk()
    expect(d.version).toBe(1)
    expect(d.active).toBeNull()
    expect(d.providers.anthropic).toBeNull()
    expect(d.providers.openai).toBeNull()
    // Should round-trip through the schema
    expect(ProvidersStateOnDisk.parse(d)).toEqual(d)
  })

  it('ProviderInjection requires apiKey to be non-empty', () => {
    expect(
      ProviderInjection.parse({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-x' }),
    ).toBeDefined()
    expect(() =>
      ProviderInjection.parse({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: '' }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/shared/types/provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the schema file**

Create `src/shared/types/provider.ts`:

```ts
import { z } from 'zod'

export const ProviderId = z.enum(['anthropic', 'openai'])
export type ProviderId = z.infer<typeof ProviderId>

export const AnthropicModel = z.enum([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
])
export type AnthropicModel = z.infer<typeof AnthropicModel>

export const OpenAIModel = z.enum(['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'])
export type OpenAIModel = z.infer<typeof OpenAIModel>

// On-disk shape. NEVER crosses an IPC boundary to the renderer.
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
export type ProvidersStateOnDisk = z.infer<typeof ProvidersStateOnDisk>

// Renderer-visible projection. apiKey replaced by hasKey.
export const ProvidersStateView = z.object({
  active: ProviderId.nullable(),
  providers: z.object({
    anthropic: z
      .object({ model: AnthropicModel, hasKey: z.boolean() })
      .nullable(),
    openai: z.object({ model: OpenAIModel, hasKey: z.boolean() }).nullable(),
  }),
})
export type ProvidersStateView = z.infer<typeof ProvidersStateView>

// Injection payload travelling Main → Worker on task.assign.
export const ProviderInjection = z.object({
  id: ProviderId,
  model: z.string().min(1),
  apiKey: z.string().min(1),
})
export type ProviderInjection = z.infer<typeof ProviderInjection>

export function defaultProvidersStateOnDisk(): ProvidersStateOnDisk {
  return {
    version: 1,
    active: null,
    providers: { anthropic: null, openai: null },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/shared/types/provider.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/provider.ts src/shared/types/provider.test.ts
git commit -m "feat(shared): provider schemas (StateOnDisk, StateView, Injection)"
```

---

## Task 3: Extend `task.assign` Inbound schema with `provider`

**Files:**
- Modify: `src/shared/types/ipc.ts:27` (extend `task.assign` variant)
- Modify: `src/shared/types/ipc.test.ts` (add coverage)

- [ ] **Step 1: Inspect the existing ipc.test.ts so the new test follows the same style**

Run: `cat src/shared/types/ipc.test.ts`

- [ ] **Step 2: Append a failing test**

Add this `describe` block to `src/shared/types/ipc.test.ts`:

```ts
import { ProviderInjection } from './provider'

describe('Inbound task.assign provider field', () => {
  it('accepts a task.assign with a provider injection', () => {
    const msg = {
      type: 'task.assign' as const,
      task: {
        id: 'task-1',
        parentId: null,
        goal: 'do thing',
        status: 'pending' as const,
        assignedWorkerId: null,
        toolAllowlist: ['peekaboo.*'],
        budget: { tokens: 100, calls: 10, wallMs: 1000, usdCents: 10 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
        result: null,
        createdAt: 0,
        startedAt: null,
        endedAt: null,
      },
      promptContext: '',
      provider: { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'sk-x' },
    }
    const parsed = InboundSchema.parse(msg)
    expect(parsed.type).toBe('task.assign')
    if (parsed.type === 'task.assign') {
      expect(parsed.provider.id).toBe('anthropic')
      expect(parsed.provider.apiKey).toBe('sk-x')
    }
  })

  it('rejects task.assign without a provider', () => {
    expect(() =>
      InboundSchema.parse({
        type: 'task.assign',
        task: { id: 'x' } as never, // task shape doesn't matter; provider missing triggers first
        promptContext: '',
      }),
    ).toThrow()
  })
})
```

- [ ] **Step 3: Run the new tests, see them fail**

Run: `pnpm vitest run src/shared/types/ipc.test.ts -t "provider field"`
Expected: FAIL — schema currently lacks `provider`.

- [ ] **Step 4: Extend the schema**

In `src/shared/types/ipc.ts`, add the import near the other type imports:

```ts
import { ProviderInjection } from './provider'
```

Replace the `task.assign` variant of `InboundSchema`:

```ts
// BEFORE
z.object({ type: z.literal('task.assign'), task: TaskSchema, promptContext: z.string() }),

// AFTER
z.object({
  type: z.literal('task.assign'),
  task: TaskSchema,
  promptContext: z.string(),
  provider: ProviderInjection,
}),
```

- [ ] **Step 5: Run all shared tests**

Run: `pnpm vitest run src/shared/types/`
Expected: PASS — all green, including the two new provider-field tests.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/ipc.ts src/shared/types/ipc.test.ts
git commit -m "feat(shared): carry provider injection on task.assign"
```

---

## Task 4: `src/main/providers/redact.ts` — `toView` projection

**Files:**
- Create: `src/main/providers/redact.ts`
- Create: `src/main/providers/redact.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/providers/redact.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { ProvidersStateOnDisk } from '@shared/types/provider'

import { toView } from './redact'

describe('toView', () => {
  it('replaces apiKey with hasKey:true when key is present', () => {
    const state: ProvidersStateOnDisk = {
      version: 1,
      active: 'anthropic',
      providers: {
        anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-secret' },
        openai: null,
      },
    }
    const view = toView(state)
    expect(view.active).toBe('anthropic')
    expect(view.providers.anthropic).toEqual({
      model: 'claude-sonnet-4-5',
      hasKey: true,
    })
    expect(view.providers.openai).toBeNull()
  })

  it('keeps null providers null', () => {
    const state: ProvidersStateOnDisk = {
      version: 1,
      active: null,
      providers: { anthropic: null, openai: null },
    }
    const view = toView(state)
    expect(view.providers.anthropic).toBeNull()
    expect(view.providers.openai).toBeNull()
  })

  it('no apiKey field survives anywhere in the view (deep walk)', () => {
    const state: ProvidersStateOnDisk = {
      version: 1,
      active: 'openai',
      providers: {
        anthropic: { model: 'claude-opus-4-7', apiKey: 'sk-a' },
        openai: { model: 'gpt-4o', apiKey: 'sk-o' },
      },
    }
    const view = toView(state)
    const json = JSON.stringify(view)
    expect(json).not.toContain('sk-a')
    expect(json).not.toContain('sk-o')
    expect(json).not.toContain('"apiKey"')
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm vitest run src/main/providers/redact.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/providers/redact.ts`:

```ts
import type { ProvidersStateOnDisk, ProvidersStateView } from '@shared/types/provider'

export function toView(state: ProvidersStateOnDisk): ProvidersStateView {
  return {
    active: state.active,
    providers: {
      anthropic: state.providers.anthropic
        ? { model: state.providers.anthropic.model, hasKey: true }
        : null,
      openai: state.providers.openai
        ? { model: state.providers.openai.model, hasKey: true }
        : null,
    },
  }
}
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm vitest run src/main/providers/redact.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/redact.ts src/main/providers/redact.test.ts
git commit -m "feat(main): providers redact toView projection"
```

---

## Task 5: `src/main/providers/store.ts` — encrypted file IO

**Files:**
- Create: `src/main/providers/store.ts`
- Create: `src/main/providers/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/providers/store.test.ts`:

```ts
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    // Identity encryption for tests so we can assert content shape.
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => {
      const s = b.toString('utf-8')
      if (!s.startsWith('enc:')) throw new Error('decrypt failed')
      return s.slice('enc:'.length)
    }),
  },
}))

import { createStore } from './store'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'providers-store-'))
  path = join(dir, 'providers.enc')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('store', () => {
  it('returns defaults when file does not exist', async () => {
    const store = createStore({ filePath: path })
    const state = await store.load()
    expect(state).toEqual({
      version: 1,
      active: null,
      providers: { anthropic: null, openai: null },
    })
  })

  it('round-trips state through write → load', async () => {
    const store = createStore({ filePath: path })
    await store.save({
      version: 1,
      active: 'anthropic',
      providers: {
        anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-rt' },
        openai: null,
      },
    })
    expect(existsSync(path)).toBe(true)
    const reread = await store.load()
    expect(reread.providers.anthropic?.apiKey).toBe('sk-rt')
  })

  it('save writes atomically via rename', async () => {
    const store = createStore({ filePath: path })
    await store.save({
      version: 1,
      active: null,
      providers: { anthropic: null, openai: null },
    })
    // Atomic write should leave no tmp file behind.
    expect(existsSync(`${path}.tmp`)).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  it('returns { ok: false, reason: "decrypt_failed" } on corrupt file and does NOT delete it', async () => {
    // Put garbage on disk that the identity-decrypt mock will reject.
    writeFileSync(path, Buffer.from('bogus-bytes'))
    const store = createStore({ filePath: path })
    const result = await store.loadOrRecover()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('decrypt_failed')
    }
    expect(existsSync(path)).toBe(true) // file preserved
  })

  it('returns { ok: false, reason: "schema_invalid" } when JSON is valid but schema fails', async () => {
    // Write a payload that decrypts cleanly but is the wrong shape.
    const ciphertext = Buffer.from(`enc:${JSON.stringify({ version: 99 })}`)
    writeFileSync(path, ciphertext)
    const store = createStore({ filePath: path })
    const result = await store.loadOrRecover()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('schema_invalid')
    }
    expect(existsSync(path)).toBe(true)
  })
})
```

- [ ] **Step 2: Run, see them fail**

Run: `pnpm vitest run src/main/providers/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/providers/store.ts`:

```ts
import { existsSync, promises as fs } from 'node:fs'
import { safeStorage } from 'electron'

import {
  defaultProvidersStateOnDisk,
  ProvidersStateOnDisk,
  type ProvidersStateOnDisk as ProvidersStateOnDiskT,
} from '@shared/types/provider'

export type LoadResult =
  | { ok: true; state: ProvidersStateOnDiskT }
  | { ok: false; reason: 'decrypt_failed' | 'schema_invalid' }

export type Store = {
  load(): Promise<ProvidersStateOnDiskT>           // forgiving — returns defaults on missing
  loadOrRecover(): Promise<LoadResult>             // strict — reports failure reason
  save(state: ProvidersStateOnDiskT): Promise<void>
}

export function createStore(opts: { filePath: string }): Store {
  const { filePath } = opts

  const load: Store['load'] = async () => {
    const r = await loadOrRecover()
    if (r.ok) return r.state
    return defaultProvidersStateOnDisk()
  }

  const loadOrRecover: Store['loadOrRecover'] = async () => {
    if (!existsSync(filePath)) {
      return { ok: true, state: defaultProvidersStateOnDisk() }
    }
    const buf = await fs.readFile(filePath)
    let json: string
    try {
      json = safeStorage.decryptString(buf)
    } catch {
      return { ok: false, reason: 'decrypt_failed' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      return { ok: false, reason: 'schema_invalid' }
    }
    const checked = ProvidersStateOnDisk.safeParse(parsed)
    if (!checked.success) return { ok: false, reason: 'schema_invalid' }
    return { ok: true, state: checked.data }
  }

  const save: Store['save'] = async (state) => {
    // Validate before encrypting so we never persist garbage.
    ProvidersStateOnDisk.parse(state)
    const ciphertext = safeStorage.encryptString(JSON.stringify(state))
    const tmp = `${filePath}.tmp`
    await fs.writeFile(tmp, ciphertext)
    await fs.rename(tmp, filePath)
  }

  return { load, loadOrRecover, save }
}
```

- [ ] **Step 4: Run, see they pass**

Run: `pnpm vitest run src/main/providers/store.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/store.ts src/main/providers/store.test.ts
git commit -m "feat(main): providers store with safeStorage + atomic write"
```

---

## Task 6: `src/main/providers/service.ts` — state machine

**Files:**
- Create: `src/main/providers/service.ts`
- Create: `src/main/providers/service.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/providers/service.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import type { ProvidersStateOnDisk } from '@shared/types/provider'

import type { Store } from './store'
import { createService } from './service'

function makeStore(initial: ProvidersStateOnDisk): Store & { saved: ProvidersStateOnDisk[] } {
  const saved: ProvidersStateOnDisk[] = []
  let current = initial
  return {
    saved,
    load: vi.fn(async () => current),
    loadOrRecover: vi.fn(async () => ({ ok: true as const, state: current })),
    save: vi.fn(async (s: ProvidersStateOnDisk) => {
      saved.push(s)
      current = s
    }),
  }
}

const empty: ProvidersStateOnDisk = {
  version: 1,
  active: null,
  providers: { anthropic: null, openai: null },
}

describe('service', () => {
  it('init populates state from store', async () => {
    const store = makeStore({
      version: 1,
      active: 'anthropic',
      providers: {
        anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-1' },
        openai: null,
      },
    })
    const svc = await createService({ store })
    expect(svc.getState().active).toBe('anthropic')
    expect(svc.getView().providers.anthropic?.hasKey).toBe(true)
  })

  it('setKey persists and broadcasts state', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })
    const calls: unknown[] = []
    svc.onStateChanged((v) => calls.push(v))

    const r = await svc.setKey('anthropic', 'sk-new')
    expect(r).toEqual({ ok: true })
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0].providers.anthropic?.apiKey).toBe('sk-new')
    expect(calls).toHaveLength(1)
  })

  it('setKey rejects empty / oversize / newline keys', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })

    expect(await svc.setKey('anthropic', '')).toEqual({
      ok: false,
      code: 'invalid',
      message: 'API key must not be empty',
    })
    expect(await svc.setKey('anthropic', 'sk-with-\nnewline')).toEqual({
      ok: false,
      code: 'invalid',
      message: 'API key must not contain newlines',
    })
    expect(await svc.setKey('anthropic', 'x'.repeat(5000))).toEqual({
      ok: false,
      code: 'invalid',
      message: 'API key too long (max 4096 chars)',
    })
    expect(store.saved).toHaveLength(0)
  })

  it('setKey preserves model if already set; defaults model otherwise', async () => {
    const store = makeStore({
      version: 1,
      active: null,
      providers: {
        anthropic: { model: 'claude-opus-4-7', apiKey: 'old' },
        openai: null,
      },
    })
    const svc = await createService({ store })
    await svc.setKey('anthropic', 'new-key')
    expect(svc.getState().providers.anthropic?.model).toBe('claude-opus-4-7')

    await svc.setKey('openai', 'gpt-key')
    expect(svc.getState().providers.openai?.model).toBe('gpt-4o') // default
  })

  it('clearKey nulls the provider and may demote active', async () => {
    const store = makeStore({
      version: 1,
      active: 'anthropic',
      providers: {
        anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-x' },
        openai: null,
      },
    })
    const svc = await createService({ store })
    await svc.clearKey('anthropic')
    expect(svc.getState().providers.anthropic).toBeNull()
    // Active stays 'anthropic' (user can re-enter a key); main-window gate uses hasKey
    expect(svc.getState().active).toBe('anthropic')
  })

  it('setActive accepts null and any ProviderId', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })
    expect((await svc.setActive('openai')).ok).toBe(true)
    expect(svc.getState().active).toBe('openai')
    expect((await svc.setActive(null)).ok).toBe(true)
    expect(svc.getState().active).toBeNull()
  })

  it('setModel updates only the provider row and validates enum', async () => {
    const store = makeStore({
      version: 1,
      active: null,
      providers: {
        anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-x' },
        openai: null,
      },
    })
    const svc = await createService({ store })
    const ok = await svc.setModel('anthropic', 'claude-opus-4-7')
    expect(ok).toEqual({ ok: true })
    expect(svc.getState().providers.anthropic?.model).toBe('claude-opus-4-7')

    const bad = await svc.setModel('anthropic', 'gpt-4o') // wrong family
    expect(bad).toEqual({
      ok: false,
      code: 'invalid',
      message: 'unknown model id for anthropic: gpt-4o',
    })
  })

  it('setModel on a not-configured provider is invalid', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })
    const r = await svc.setModel('openai', 'gpt-4o')
    expect(r).toEqual({
      ok: false,
      code: 'invalid',
      message: 'no key configured for openai; set a key first',
    })
  })

  it('in-memory state does not advance when store.save throws', async () => {
    const store = makeStore(empty)
    store.save = vi.fn(async () => {
      throw new Error('disk full')
    })
    const svc = await createService({ store })
    const r = await svc.setKey('anthropic', 'sk-x')
    expect(r).toEqual({ ok: false, code: 'persist_failed', message: 'disk full' })
    expect(svc.getState().providers.anthropic).toBeNull()
  })

  it('getInjection returns { id, model, apiKey } for the active provider', async () => {
    const store = makeStore({
      version: 1,
      active: 'anthropic',
      providers: {
        anthropic: { model: 'claude-haiku-4-5', apiKey: 'sk-y' },
        openai: null,
      },
    })
    const svc = await createService({ store })
    const inj = svc.getInjection()
    expect(inj).toEqual({
      id: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'sk-y',
    })
  })

  it('getInjection returns null when no active or active has no key', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })
    expect(svc.getInjection()).toBeNull()

    await svc.setActive('anthropic')
    expect(svc.getInjection()).toBeNull() // no key yet
  })
})
```

- [ ] **Step 2: Run, see them fail**

Run: `pnpm vitest run src/main/providers/service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/providers/service.ts`:

```ts
import {
  AnthropicModel,
  defaultProvidersStateOnDisk,
  OpenAIModel,
  type ProviderId,
  type ProviderInjection,
  type ProvidersStateOnDisk,
  type ProvidersStateView,
} from '@shared/types/provider'

import { toView } from './redact'
import type { Store } from './store'

export type SetResult =
  | { ok: true }
  | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type Service = {
  getState(): ProvidersStateOnDisk
  getView(): ProvidersStateView
  getInjection(): ProviderInjection | null
  setKey(p: ProviderId, key: string): Promise<SetResult>
  clearKey(p: ProviderId): Promise<SetResult>
  setActive(p: ProviderId | null): Promise<SetResult>
  setModel(p: ProviderId, model: string): Promise<SetResult>
  onStateChanged(cb: (v: ProvidersStateView) => void): () => void
}

const DEFAULT_MODEL: Record<ProviderId, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
}

function validateKey(key: string): SetResult | null {
  if (key.length === 0) return { ok: false, code: 'invalid', message: 'API key must not be empty' }
  if (/[\r\n]/.test(key))
    return { ok: false, code: 'invalid', message: 'API key must not contain newlines' }
  if (key.length > 4096)
    return { ok: false, code: 'invalid', message: 'API key too long (max 4096 chars)' }
  return null
}

function validateModel(p: ProviderId, model: string): SetResult | null {
  const enumForProvider = p === 'anthropic' ? AnthropicModel : OpenAIModel
  const parsed = enumForProvider.safeParse(model)
  if (!parsed.success)
    return { ok: false, code: 'invalid', message: `unknown model id for ${p}: ${model}` }
  return null
}

export async function createService(opts: { store: Store }): Promise<Service> {
  let state = await opts.store.load()
  const listeners = new Set<(v: ProvidersStateView) => void>()

  const emit = (): void => {
    const v = toView(state)
    for (const cb of listeners) cb(v)
  }

  const persist = async (next: ProvidersStateOnDisk): Promise<SetResult> => {
    try {
      await opts.store.save(next)
    } catch (e) {
      return {
        ok: false,
        code: 'persist_failed',
        message: e instanceof Error ? e.message : String(e),
      }
    }
    state = next
    emit()
    return { ok: true }
  }

  return {
    getState: () => state,
    getView: () => toView(state),
    getInjection: () => {
      if (!state.active) return null
      const row = state.providers[state.active]
      if (!row) return null
      return { id: state.active, model: row.model, apiKey: row.apiKey }
    },
    async setKey(p, key) {
      const v = validateKey(key)
      if (v) return v
      // Branch on p so TS can narrow the model literal type for each provider.
      let next: ProvidersStateOnDisk
      if (p === 'anthropic') {
        const existing = state.providers.anthropic
        const model = existing
          ? existing.model
          : (DEFAULT_MODEL.anthropic as 'claude-sonnet-4-5')
        next = {
          ...state,
          providers: { ...state.providers, anthropic: { model, apiKey: key } },
        }
      } else {
        const existing = state.providers.openai
        const model = existing ? existing.model : (DEFAULT_MODEL.openai as 'gpt-4o')
        next = {
          ...state,
          providers: { ...state.providers, openai: { model, apiKey: key } },
        }
      }
      return persist(next)
    },
    async clearKey(p) {
      const next: ProvidersStateOnDisk = {
        ...state,
        providers: { ...state.providers, [p]: null },
      }
      return persist(next)
    },
    async setActive(p) {
      const next: ProvidersStateOnDisk = { ...state, active: p }
      return persist(next)
    },
    async setModel(p, model) {
      const v = validateModel(p, model)
      if (v) return v
      // Branch so TS narrows the row + model literal types per provider.
      if (p === 'anthropic') {
        const row = state.providers.anthropic
        if (!row)
          return {
            ok: false,
            code: 'invalid',
            message: 'no key configured for anthropic; set a key first',
          }
        const next: ProvidersStateOnDisk = {
          ...state,
          providers: {
            ...state.providers,
            anthropic: { ...row, model: AnthropicModel.parse(model) },
          },
        }
        return persist(next)
      } else {
        const row = state.providers.openai
        if (!row)
          return {
            ok: false,
            code: 'invalid',
            message: 'no key configured for openai; set a key first',
          }
        const next: ProvidersStateOnDisk = {
          ...state,
          providers: {
            ...state.providers,
            openai: { ...row, model: OpenAIModel.parse(model) },
          },
        }
        return persist(next)
      }
    },
    onStateChanged(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

// Re-exports used by callers that just want a fresh empty state.
export { defaultProvidersStateOnDisk }
```

- [ ] **Step 4: Run, see them pass**

Run: `pnpm vitest run src/main/providers/service.test.ts`
Expected: PASS — all 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/service.ts src/main/providers/service.test.ts
git commit -m "feat(main): providers service state machine"
```

---

## Task 7: `src/main/providers/test-connection.ts` — HTTP ping

**Files:**
- Create: `src/main/providers/test-connection.ts`
- Create: `src/main/providers/test-connection.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/providers/test-connection.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { testConnection } from './test-connection'

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
})

describe('testConnection', () => {
  it('returns ok:true and latencyMs for HTTP 200', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    const r = await testConnection({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('maps HTTP 401 to unauthorized', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 401 }))
    const r = await testConnection({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk' })
    expect(r).toMatchObject({ ok: false, code: 'unauthorized' })
  })

  it('maps HTTP 403 to unauthorized', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 403 }))
    const r = await testConnection({ id: 'openai', model: 'gpt-4o', apiKey: 'sk' })
    expect(r).toMatchObject({ ok: false, code: 'unauthorized' })
  })

  it('maps HTTP 429 to rate_limited', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 429 }))
    const r = await testConnection({ id: 'openai', model: 'gpt-4o', apiKey: 'sk' })
    expect(r).toMatchObject({ ok: false, code: 'rate_limited' })
  })

  it('maps other non-2xx to unknown with status code in message', async () => {
    global.fetch = vi.fn(async () => new Response('boom', { status: 503 }))
    const r = await testConnection({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('unknown')
      expect(r.message).toContain('503')
    }
  })

  it('maps fetch throw / timeout to network', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const r = await testConnection({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk' })
    expect(r).toMatchObject({ ok: false, code: 'network' })
  })

  it('targets Anthropic /v1/messages with the model + key', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }))
    global.fetch = f
    await testConnection({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-anth' })
    const [url, init] = f.mock.calls[0]
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-anth')
    expect(headers['anthropic-version']).toBeDefined()
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.model).toBe('claude-sonnet-4-5')
    expect(body.max_tokens).toBe(1)
  })

  it('targets OpenAI /v1/chat/completions with Bearer token', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }))
    global.fetch = f
    await testConnection({ id: 'openai', model: 'gpt-4o', apiKey: 'sk-openai' })
    const [url, init] = f.mock.calls[0]
    expect(String(url)).toBe('https://api.openai.com/v1/chat/completions')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-openai')
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.model).toBe('gpt-4o')
    expect(body.max_tokens).toBe(1)
  })
})
```

- [ ] **Step 2: Run, see them fail**

Run: `pnpm vitest run src/main/providers/test-connection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/providers/test-connection.ts`:

```ts
import type { ProviderInjection } from '@shared/types/provider'

export type TestResult =
  | { ok: true; latencyMs: number }
  | {
      ok: false
      code: 'no_key' | 'unauthorized' | 'rate_limited' | 'network' | 'unknown'
      message: string
    }

const TIMEOUT_MS = 10_000
const ANTHROPIC_VERSION = '2023-06-01'

export async function testConnection(p: ProviderInjection): Promise<TestResult> {
  if (!p.apiKey) return { ok: false, code: 'no_key', message: 'no API key' }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  const started = Date.now()

  try {
    const res =
      p.id === 'anthropic'
        ? await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            signal: ac.signal,
            headers: {
              'content-type': 'application/json',
              'x-api-key': p.apiKey,
              'anthropic-version': ANTHROPIC_VERSION,
            },
            body: JSON.stringify({
              model: p.model,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
          })
        : await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            signal: ac.signal,
            headers: {
              'content-type': 'application/json',
              Authorization: `Bearer ${p.apiKey}`,
            },
            body: JSON.stringify({
              model: p.model,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
          })

    const latencyMs = Date.now() - started
    if (res.ok) return { ok: true, latencyMs }
    if (res.status === 401 || res.status === 403)
      return { ok: false, code: 'unauthorized', message: `HTTP ${res.status}` }
    if (res.status === 429) return { ok: false, code: 'rate_limited', message: 'HTTP 429' }
    return { ok: false, code: 'unknown', message: `HTTP ${res.status}` }
  } catch (e) {
    return {
      ok: false,
      code: 'network',
      message: e instanceof Error ? e.message : String(e),
    }
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: Run, see them pass**

Run: `pnpm vitest run src/main/providers/test-connection.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/test-connection.ts src/main/providers/test-connection.test.ts
git commit -m "feat(main): providers test-connection HTTP ping"
```

---

## Task 8: `src/main/providers/ipc.ts` — IPC handlers + event broadcast

**Files:**
- Create: `src/main/providers/ipc.ts`
- Create: `src/main/providers/index.ts`

- [ ] **Step 1: Implement the IPC wiring (no test — covered by integration in Task 11)**

Create `src/main/providers/ipc.ts`:

```ts
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'

import { createLogger } from '@shared/logger'
import { ProviderId } from '@shared/types/provider'

import type { Service } from './service'
import { testConnection } from './test-connection'

const log = createLogger({ process: 'main' }).child({ component: 'providers-ipc' })

const STATE_CHANGED_CHANNEL = 'providers:stateChanged'
const DECRYPT_FAILED_CHANNEL = 'providers:decryptFailed'

export function wireProvidersIpc(args: {
  service: Service
  decryptFailedAtBoot: boolean
}): { dispose: () => void } {
  const { service, decryptFailedAtBoot } = args

  const broadcast = (channel: string, payload?: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  }

  // Push state changes to every renderer window.
  const unsubscribe = service.onStateChanged((view) => {
    broadcast(STATE_CHANGED_CHANNEL, view)
  })

  // One-shot at boot if applicable. Fired on any new window via did-finish-load.
  const fireDecryptIfNeeded = (w: BrowserWindow): void => {
    if (decryptFailedAtBoot && !w.isDestroyed()) {
      w.webContents.send(DECRYPT_FAILED_CHANNEL)
    }
  }
  const onWebContentsCreated = (
    _: Electron.Event,
    contents: Electron.WebContents,
  ): void => {
    contents.once('did-finish-load', () => {
      const w = BrowserWindow.fromWebContents(contents)
      if (w) fireDecryptIfNeeded(w)
    })
  }
  app.on('web-contents-created', onWebContentsCreated)
  // Cover already-open windows
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents.isLoading()) {
      w.webContents.once('did-finish-load', () => fireDecryptIfNeeded(w))
    } else {
      fireDecryptIfNeeded(w)
    }
  }

  const get = (): unknown => service.getView()
  ipcMain.handle('providers:get', get)

  const setKey = async (_: Electron.IpcMainInvokeEvent, p: unknown, key: unknown) => {
    const pid = ProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'invalid', message: 'unknown provider id' }
    if (typeof key !== 'string')
      return { ok: false, code: 'invalid', message: 'key must be a string' }
    return service.setKey(pid.data, key)
  }
  ipcMain.handle('providers:setKey', setKey)

  const clearKey = async (_: Electron.IpcMainInvokeEvent, p: unknown) => {
    const pid = ProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'invalid', message: 'unknown provider id' }
    return service.clearKey(pid.data)
  }
  ipcMain.handle('providers:clearKey', clearKey)

  const setActive = async (_: Electron.IpcMainInvokeEvent, p: unknown) => {
    if (p === null) return service.setActive(null)
    const pid = ProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'invalid', message: 'unknown provider id' }
    return service.setActive(pid.data)
  }
  ipcMain.handle('providers:setActive', setActive)

  const setModel = async (_: Electron.IpcMainInvokeEvent, p: unknown, model: unknown) => {
    const pid = ProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'invalid', message: 'unknown provider id' }
    if (typeof model !== 'string')
      return { ok: false, code: 'invalid', message: 'model must be a string' }
    return service.setModel(pid.data, model)
  }
  ipcMain.handle('providers:setModel', setModel)

  const test = async (_: Electron.IpcMainInvokeEvent, p: unknown) => {
    const pid = ProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'unknown', message: 'unknown provider id' }
    const state = service.getState()
    const row = state.providers[pid.data]
    if (!row) return { ok: false, code: 'no_key', message: 'no key configured' }
    return testConnection({ id: pid.data, model: row.model, apiKey: row.apiKey })
  }
  ipcMain.handle('providers:test', test)

  log.info({ msg: 'providers IPC wired', decryptFailedAtBoot })

  return {
    dispose(): void {
      unsubscribe()
      app.off('web-contents-created', onWebContentsCreated)
      ipcMain.removeHandler('providers:get')
      ipcMain.removeHandler('providers:setKey')
      ipcMain.removeHandler('providers:clearKey')
      ipcMain.removeHandler('providers:setActive')
      ipcMain.removeHandler('providers:setModel')
      ipcMain.removeHandler('providers:test')
    },
  }
}

// Helper used by main entry to check whether safeStorage will work at all.
export function safeStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}
```

- [ ] **Step 2: Create a barrel export for the main entry**

Create `src/main/providers/index.ts`:

```ts
import { join } from 'node:path'
import { app, dialog } from 'electron'

import { createLogger } from '@shared/logger'

import { wireProvidersIpc, safeStorageAvailable } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'providers' })

export type ProvidersHandle = {
  service: Service
  dispose(): void
}

/**
 * Initialise the providers subsystem. Must be called after app.whenReady()
 * and BEFORE any BrowserWindow is created so the first render of the main
 * window already sees the current state.
 */
export async function initProviders(): Promise<ProvidersHandle> {
  if (!safeStorageAvailable()) {
    dialog.showErrorBox(
      'Secure storage unavailable',
      'SwarmAgents cannot start because the operating system did not provide an encrypted storage backend. On macOS this usually means the Keychain is locked or inaccessible.',
    )
    app.quit()
    throw new Error('safeStorage unavailable')
  }

  const filePath = join(app.getPath('userData'), 'providers.enc')
  const store = createStore({ filePath })
  const loadResult = await store.loadOrRecover()
  const decryptFailedAtBoot = !loadResult.ok

  if (!loadResult.ok) {
    log.warn({ msg: 'providers load failed at boot', reason: loadResult.reason })
  }

  const service = await createService({ store })
  const { dispose } = wireProvidersIpc({ service, decryptFailedAtBoot })

  return { service, dispose }
}

export type { Service } from './service'
```

- [ ] **Step 3: Run typecheck to make sure nothing dangles**

Run: `pnpm typecheck:node`
Expected: PASS — no errors in `src/main/providers/*` or `src/shared/types/provider.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/main/providers/ipc.ts src/main/providers/index.ts
git commit -m "feat(main): providers IPC handlers + init module"
```

---

## Task 9: Logger redaction in `src/shared/logger.ts`

**Files:**
- Modify: `src/shared/logger.ts`

- [ ] **Step 1: Add a failing test**

Append to `src/shared/logger.ts` test file path. If `src/shared/logger.test.ts` doesn't exist, create it:

```ts
import { describe, expect, it } from 'vitest'

import { createLogger } from './logger'

describe('logger redaction', () => {
  it('redacts apiKey and provider.apiKey fields from logged objects', () => {
    const written: string[] = []
    const log = createLogger({ process: 'test' })
    // pino's transport=stdout by default. Capture by replacing process.stdout.write.
    const orig = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'))
      return true
    }) as typeof process.stdout.write
    try {
      log.info({ apiKey: 'sk-direct', provider: { apiKey: 'sk-nested', id: 'anthropic' } })
    } finally {
      process.stdout.write = orig
    }
    const joined = written.join('')
    expect(joined).not.toContain('sk-direct')
    expect(joined).not.toContain('sk-nested')
    expect(joined).toContain('"id":"anthropic"') // non-secret fields survive
  })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm vitest run src/shared/logger.test.ts`
Expected: FAIL — secrets visible in output.

- [ ] **Step 3: Add redact config**

Modify `src/shared/logger.ts`:

```ts
import pino, { type Logger } from 'pino'

export type LoggerBindings = {
  process: 'main' | 'worker' | 'test'
  workerId?: string
  taskId?: string
}

const isDev = process.env.NODE_ENV !== 'production'

export function createLogger(bindings: LoggerBindings): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    base: bindings,
    redact: {
      paths: ['apiKey', '*.apiKey', 'provider.apiKey', 'providers.*.apiKey', 'key', '*.key'],
      censor: '[REDACTED]',
    },
  })
}
```

- [ ] **Step 4: Run, see it pass**

Run: `pnpm vitest run src/shared/logger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/logger.ts src/shared/logger.test.ts
git commit -m "feat(shared): pino redact for apiKey + key paths"
```

---

## Task 10: Extend `SwarmBridge` in `src/shared/types/ui.ts`

**Files:**
- Modify: `src/shared/types/ui.ts`

- [ ] **Step 1: Add Providers bridge typedef + extend SwarmBridge**

In `src/shared/types/ui.ts`, add imports near the existing ones:

```ts
import type { ProviderId, ProvidersStateView } from './provider'
```

Add this type before `SwarmBridge`:

```ts
export type ProvidersSetResult =
  | { ok: true }
  | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type ProvidersTestResult =
  | { ok: true; latencyMs: number }
  | {
      ok: false
      code: 'no_key' | 'unauthorized' | 'rate_limited' | 'network' | 'unknown'
      message: string
    }

export type ProvidersBridge = {
  get(): Promise<ProvidersStateView>
  setKey(p: ProviderId, key: string): Promise<ProvidersSetResult>
  clearKey(p: ProviderId): Promise<ProvidersSetResult>
  setActive(p: ProviderId | null): Promise<ProvidersSetResult>
  setModel(p: ProviderId, model: string): Promise<ProvidersSetResult>
  test(p: ProviderId): Promise<ProvidersTestResult>
  onStateChanged(cb: (v: ProvidersStateView) => void): () => void
  onDecryptFailed(cb: () => void): () => void
}
```

Modify the existing `SwarmBridge` type to:

```ts
export type SwarmBridge = {
  submitGoal(goal: string): Promise<SubmitGoalResult>
  cancelTask(taskId: string): Promise<void>
  decidePermission(actionId: string, decision: PermissionDecision): Promise<void>
  subscribeEvents(cb: (event: UIEvent) => void): () => void
  /** Get the current system accent color (RRGGBBAA hex). Returns null on unsupported platforms. */
  getAccent(): Promise<string | null>
  /** Subscribe to accent-color changes. Returns an unsubscribe function. */
  onAccentChange(cb: (hex: string) => void): () => void
  showConfirm(req: ConfirmRequest): Promise<ConfirmResponse>
  /** Open the Settings window. Optional initialRoute selects which tab to land on. */
  openSettings(opts?: { initialRoute?: string }): Promise<void>
  providers: ProvidersBridge
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: FAIL — preload + renderer references `swarm.providers` not yet defined; that's the next task. For this task we expect typecheck still passing in `tsconfig.node.json` (shared types compile), so use:

Run: `pnpm typecheck:node`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/ui.ts
git commit -m "feat(shared): extend SwarmBridge with providers namespace"
```

---

## Task 11: Wire providers init into main entry

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/swarm-ipc.ts` (accept openSettings options)
- Modify: `src/main/windows/settings-window.ts` (accept initialRoute)

- [ ] **Step 1: Extend `settings-window.ts` to accept an initialRoute**

Modify the `openSettings` function signature and `loadURL` / `loadFile` calls:

```ts
// src/main/windows/settings-window.ts
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { BrowserWindow } from 'electron'

import { suppressContextMenu } from '../system/context-menu'

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

let settingsWin: BrowserWindow | null = null

export function openSettings(opts: { initialRoute?: string } = {}): void {
  const hash = opts.initialRoute ? `#${opts.initialRoute}` : ''

  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus()
    if (opts.initialRoute) {
      // Navigate the existing window to the requested route via the hash history.
      settingsWin.webContents.executeJavaScript(
        `window.location.hash = ${JSON.stringify(`#${opts.initialRoute}`)};`,
      )
    }
    return
  }

  const win = new BrowserWindow({
    width: 720,
    height: 520,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    backgroundColor: isMac ? '#00000000' : '#1b1b1f',
    transparent: isMac,
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          vibrancy: 'sidebar' as const,
          visualEffectState: 'active' as const,
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })

  if (isWin) {
    try {
      win.setBackgroundMaterial('mica')
    } catch {
      /* fallback solid */
    }
  }

  suppressContextMenu(win)
  win.on('ready-to-show', () => {
    win.show()
  })
  win.on('closed', () => {
    settingsWin = null
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/settings.html${hash}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/settings.html'), { hash: opts.initialRoute })
  }

  settingsWin = win
}
```

- [ ] **Step 2: Accept route option in `system:openSettings` IPC**

In `src/main/ipc/swarm-ipc.ts`, replace the `handleOpenSettings` definition:

```ts
const handleOpenSettings = (_: Electron.IpcMainInvokeEvent, opts?: unknown): void => {
  let initialRoute: string | undefined
  if (
    opts &&
    typeof opts === 'object' &&
    'initialRoute' in opts &&
    typeof (opts as { initialRoute?: unknown }).initialRoute === 'string'
  ) {
    initialRoute = (opts as { initialRoute: string }).initialRoute
  }
  openSettings(initialRoute ? { initialRoute } : {})
}
```

- [ ] **Step 3: Init providers + wire IPC in `main/index.ts`**

Modify the import block and the `whenReady` body:

```ts
// add to the existing imports
import { initProviders } from './providers'
```

In the body of `app.whenReady().then(async () => { ... })`, insert this **before** `createMainWindow()`:

```ts
const providers = await initProviders()
log.info({ msg: 'providers initialised' })

app.on('before-quit', () => {
  providers.dispose()
})
```

(Leave the existing `before-quit` handler that calls `supervisor.shutdown()` in place; it's fine to have two handlers.)

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck:node`
Expected: PASS.

- [ ] **Step 5: Run all main + shared tests**

Run: `pnpm vitest run src/main src/shared`
Expected: PASS — nothing should regress (we only added wiring; existing tests are untouched).

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts src/main/ipc/swarm-ipc.ts src/main/windows/settings-window.ts
git commit -m "feat(main): wire providers init + initialRoute on settings window"
```

---

## Task 12: Extend supervisor to carry provider injection

**Files:**
- Modify: `src/main/supervisor/index.ts`
- Modify: `src/main/supervisor/index.test.ts`
- Modify: `src/main/ipc/swarm-ipc.ts` (submitGoal asks providers service for injection)

- [ ] **Step 1: Add a failing test for the dispatch payload**

Open `src/main/supervisor/index.test.ts`. Find where existing tests assert the dispatch payload sent through the spawner mock. Append:

```ts
import type { ProviderInjection } from '@shared/types/provider'

it('dispatch forwards the provider injection on task.assign', async () => {
  const captured: unknown[] = []
  const sup = createSupervisor({
    spawner: {
      spawn: () => ({
        workerId: 'w-test',
        send: (m: unknown) => captured.push(m),
        onMessage: () => {},
        onExit: () => {},
        kill: () => {},
        exited: Promise.resolve(),
      }),
    } as never,
    workerEntry: 'unused',
    poolSize: 1,
  })
  await sup.start()
  const inj: ProviderInjection = {
    id: 'anthropic',
    model: 'claude-sonnet-4-5',
    apiKey: 'sk-test',
  }
  sup.dispatch(
    {
      id: 't1',
      parentId: null,
      goal: 'do it',
      status: 'pending',
      assignedWorkerId: null,
      toolAllowlist: ['*'],
      budget: { tokens: 1, calls: 1, wallMs: 1, usdCents: 1 },
      used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
      history: [],
      result: null,
      createdAt: 0,
      startedAt: null,
      endedAt: null,
    },
    inj,
  )
  // captured[0] is task.assign.
  expect(captured[0]).toMatchObject({ type: 'task.assign', provider: inj })
})
```

- [ ] **Step 2: Run, see it fail**

Run: `pnpm vitest run src/main/supervisor/index.test.ts -t "provider injection"`
Expected: FAIL — `dispatch` only takes one arg, or `provider` missing on the sent message.

- [ ] **Step 3: Extend supervisor `dispatch`**

In `src/main/supervisor/index.ts`:

```ts
// 1. Update the queue element type
const queue: Array<{ task: Task; provider: ProviderInjection }> = []

// 2. Add the import
import type { ProviderInjection } from '@shared/types/provider'

// 3. Update tryDispatchNext to read both task + provider from the queue
const tryDispatchNext = (): void => {
  if (shuttingDown) return
  if (queue.length === 0) return
  const slot = slots.find((s) => s.state === 'idle')
  if (!slot) return
  const next = queue.shift()
  if (!next) return
  const { task, provider } = next
  slot.state = 'busy'
  slot.currentTaskId = task.id
  log.info({ msg: 'dispatching', taskId: task.id, workerId: slot.handle.workerId })
  send(slot, { type: 'task.assign', task, promptContext: '', provider })
  ee.emit('task.dispatched', task.id, slot.handle.workerId)
}

// 4. Update the exported dispatch signature
return {
  // ...
  dispatch(task: Task, provider: ProviderInjection): void {
    if (shuttingDown) throw new Error('supervisor is shutting down')
    queue.push({ task, provider })
    tryDispatchNext()
  },
  // ...
}
```

Also update the `Supervisor` type alias:

```ts
export type Supervisor = {
  start(): Promise<void>
  dispatch(task: Task, provider: ProviderInjection): void
  sendToWorker(workerId: string, msg: Inbound): boolean
  shutdown(): Promise<void>
  on<K extends keyof SupervisorEvents>(event: K, cb: SupervisorEvents[K]): void
}
```

Update the queue shutdown drain to use the new shape:

```ts
while (queue.length > 0) {
  const dropped = queue.shift()
  if (!dropped) continue
  ee.emit('task.error', dropped.task.id, {
    code: 'supervisor_shutdown',
    message: 'supervisor shut down before task was dispatched',
    tier: 'fatal',
  })
}
```

- [ ] **Step 4: Update `swarm-ipc.ts` submitGoal to source the injection**

`wireSwarmIpc` needs the providers service. Add a parameter:

```ts
// imports
import type { Service as ProvidersService } from '../providers'

// signature
export function wireSwarmIpc(args: {
  supervisor: Supervisor
  permissionGate: PermissionGate
  providers: ProvidersService
}): { dispose: () => void } {
  const { supervisor, permissionGate, providers } = args
  // ...
}
```

Replace the `submitGoal` body:

```ts
const submitGoal = (
  _e: Electron.IpcMainInvokeEvent,
  goal: string,
): { taskId: string } => {
  if (typeof goal !== 'string' || goal.trim().length === 0) {
    throw new Error('goal must be a non-empty string')
  }
  const injection = providers.getInjection()
  if (!injection) {
    // Defense-in-depth: the UI gate should make this unreachable.
    throw new Error('no_provider: configure an API key in Settings before starting tasks')
  }
  const taskId = ulid()
  const now = Date.now()
  const task: Task = {
    id: taskId,
    parentId: null,
    goal: goal.trim(),
    status: 'pending',
    assignedWorkerId: null,
    toolAllowlist: ['peekaboo.*', 'web.*', 'fs.*'],
    budget: { ...DEFAULT_BUDGET },
    used: { ...EMPTY_USED },
    history: [],
    result: null,
    createdAt: now,
    startedAt: null,
    endedAt: null,
  }
  broadcast({ kind: 'task.created', taskId, goal: task.goal, ts: now })
  supervisor.dispatch(task, injection)
  log.info({ msg: 'task submitted', taskId, goal: task.goal, provider: injection.id })
  return { taskId }
}
```

- [ ] **Step 5: Pass the providers service into wireSwarmIpc from main/index.ts**

In `src/main/index.ts`, find the `wireSwarmIpc({ supervisor, permissionGate })` call and update to:

```ts
wireSwarmIpc({ supervisor, permissionGate, providers: providers.service })
```

- [ ] **Step 6: Run all supervisor + ipc tests**

Run: `pnpm vitest run src/main/supervisor src/main/ipc`
Expected: PASS — including the new provider-injection test. Existing supervisor tests that call `sup.dispatch(task)` now need to pass a dummy `provider` — fix any failures by appending a stub injection:

```ts
sup.dispatch(task, { id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-test' })
```

- [ ] **Step 7: Commit**

```bash
git add src/main/supervisor src/main/ipc/swarm-ipc.ts src/main/index.ts
git commit -m "feat(main): supervisor dispatch carries provider injection"
```

---

## Task 13: Worker handler — accept provider, drop env-var fallback

**Files:**
- Modify: `src/worker/handler.ts`
- Modify: `src/worker/handler.test.ts`

- [ ] **Step 1: Append failing tests to `src/worker/handler.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest'

import { handleInbound } from './handler'

const stubTask = {
  id: 't1',
  parentId: null,
  goal: 'g',
  status: 'pending' as const,
  assignedWorkerId: null,
  toolAllowlist: ['*'],
  budget: { tokens: 1, calls: 1, wallMs: 1, usdCents: 1 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  history: [],
  result: null,
  createdAt: 0,
  startedAt: null,
  endedAt: null,
}
const stubProvider = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'sk-test' }

describe('handler — provider injection', () => {
  it('routes to real agent path when SWARM_USE_SIMULATOR is not set', async () => {
    const original = process.env.SWARM_USE_SIMULATOR
    delete process.env.SWARM_USE_SIMULATOR
    const sent: unknown[] = []
    handleInbound(
      {
        type: 'task.assign',
        task: stubTask,
        promptContext: '',
        provider: stubProvider,
      },
      (m) => sent.push(m),
    )
    // The real agent is async; we only assert the *routing decision*: no
    // 'progress' event with 'simulator' text should appear synchronously.
    await new Promise((r) => setTimeout(r, 0))
    const sim = sent.find(
      (m) =>
        typeof m === 'object' && m && (m as { type?: string }).type === 'progress',
    )
    if (sim) {
      const text = JSON.stringify(sim)
      expect(text).not.toContain('simulator')
    }
    if (original !== undefined) process.env.SWARM_USE_SIMULATOR = original
  })

  it('routes to simulator when SWARM_USE_SIMULATOR=1', async () => {
    const original = process.env.SWARM_USE_SIMULATOR
    process.env.SWARM_USE_SIMULATOR = '1'
    const sent: unknown[] = []
    handleInbound(
      {
        type: 'task.assign',
        task: stubTask,
        promptContext: '',
        provider: stubProvider,
      },
      (m) => sent.push(m),
    )
    await new Promise((r) => setTimeout(r, 5))
    // simulator emits at least one progress event quickly
    expect(
      sent.some(
        (m) => typeof m === 'object' && m && (m as { type?: string }).type === 'progress',
      ),
    ).toBe(true)
    if (original !== undefined) process.env.SWARM_USE_SIMULATOR = original
    else delete process.env.SWARM_USE_SIMULATOR
  })
})
```

- [ ] **Step 2: Run, see them fail (or behave incorrectly)**

Run: `pnpm vitest run src/worker/handler.test.ts -t "provider injection"`
Expected: FAIL — handler currently routes to simulator whenever `ANTHROPIC_API_KEY` is missing.

- [ ] **Step 3: Rewrite the routing logic**

Replace `src/worker/handler.ts`:

```ts
import type { Inbound, Outbound } from '@shared/types/ipc'

import { runPiAgent } from './pi-agent'
import { createPermissionClient, type PermissionClient } from './permission-client'
import { simulateThinking } from './simulator'

export type SendFn = (msg: Outbound) => void

const useSimulator = (): boolean => process.env.SWARM_USE_SIMULATOR === '1'

let permissionClient: PermissionClient | null = null

function getPermissionClient(send: SendFn): PermissionClient {
  if (!permissionClient) permissionClient = createPermissionClient(send)
  return permissionClient
}

export function handleInbound(msg: Inbound, send: SendFn): void {
  switch (msg.type) {
    case 'task.assign':
      if (useSimulator()) {
        void simulateThinking(msg.task, send)
        return
      }
      void runPiAgent(msg.task, {
        send,
        permissionClient: getPermissionClient(send),
        provider: msg.provider,
      })
      return
    case 'permission.decision':
      getPermissionClient(send).resolve(msg.actionId, msg.decision)
      return
    case 'task.cancel':
    case 'tool.result':
    case 'shutdown':
      return
  }
}
```

- [ ] **Step 4: Run, see them pass**

Run: `pnpm vitest run src/worker/handler.test.ts`
Expected: PASS — both new tests + existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/worker/handler.ts src/worker/handler.test.ts
git commit -m "feat(worker): require provider injection; drop env-var fallback"
```

---

## Task 14: Worker pi-agent — read key/model from injection

**Files:**
- Modify: `src/worker/pi-agent/index.ts`
- Modify: `src/worker/pi-agent/index.test.ts`

**Branching:** the body of this task depends on the Task 1 spike outcome. Use **Path A** if `pi-ai` accepts `apiKey`, **Path B** if it requires migration.

### Path A — keep `@earendil-works/pi-ai`

- [ ] **Step A1: Rewrite the test**

Replace `src/worker/pi-agent/index.test.ts`'s existing "emits task.error when ANTHROPIC_API_KEY is missing" with:

```ts
import { describe, expect, it, vi } from 'vitest'

import { runPiAgent } from './index'

const stubTask = {
  id: 't1',
  parentId: null,
  goal: 'g',
  status: 'pending' as const,
  assignedWorkerId: null,
  toolAllowlist: ['*'],
  budget: { tokens: 1, calls: 1, wallMs: 1, usdCents: 1 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  history: [],
  result: null,
  createdAt: 0,
  startedAt: null,
  endedAt: null,
}

describe('runPiAgent', () => {
  it('does not read ANTHROPIC_API_KEY from process.env', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    const sent: unknown[] = []
    // Provide a fake permissionClient (no-op for read-only tools).
    const permissionClient = { request: vi.fn(async () => 'grant'), resolve: vi.fn() } as never
    await runPiAgent(stubTask, {
      send: (m) => sent.push(m),
      permissionClient,
      provider: { id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-from-injection' },
    })
    // Should NOT have emitted a missing_api_key error.
    expect(
      sent.some(
        (m) =>
          typeof m === 'object' &&
          m &&
          (m as { type?: string }).type === 'task.error' &&
          (m as { error?: { code?: string } }).error?.code === 'missing_api_key',
      ),
    ).toBe(false)
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original
  })
})
```

- [ ] **Step A2: Rewrite the implementation**

Replace `src/worker/pi-agent/index.ts`:

```ts
import { Agent } from '@earendil-works/pi-agent-core'
import { getModel } from '@earendil-works/pi-ai'
import type { Outbound } from '@shared/types/ipc'
import type { ProviderInjection } from '@shared/types/provider'
import type { Task } from '@shared/types/task'

import type { PermissionClient } from '../permission-client'
import { createEventTranslator } from './events'
import { buildPeekabooTools } from './tools/peekaboo'

type Deps = {
  send: (m: Outbound) => void
  permissionClient: PermissionClient
  provider: ProviderInjection
}

const SYSTEM_PROMPT = `You are SwarmAgents, an autonomous worker agent operating a user's Mac.

You have these tools:
  - see_screen({mode}): capture the screen and get a list of UI elements with Peekaboo IDs.
  - list_apps(): enumerate running apps and their windows.

Workflow:
  1. Read the goal carefully.
  2. If the goal needs visual context, call see_screen first.
  3. If purely informational ("what apps?"), use the matching tool.
  4. Think out loud briefly between tool calls.
  5. Write a one-paragraph summary at the end. Do not loop indefinitely.
  6. If a tool returns an error (e.g. permission denied), explain it in the summary instead of retrying blindly.`

export async function runPiAgent(task: Task, deps: Deps): Promise<void> {
  const tools = buildPeekabooTools({
    send: deps.send,
    requestPermission: (args) =>
      deps.permissionClient.request({
        taskId: task.id,
        toolName: args.toolName,
        risk: args.risk,
        summary: args.summary,
        payload: args.payload,
      }),
  })

  // Spike (Task 1) verified: pi-ai's `getModel` is strictly 2-arity and silently
  // ignores a 3rd arg. The Agent constructor takes AgentOptions, which exposes
  // a `getApiKey?(provider): string | undefined` callback — the supported,
  // strict-typed way to inject the key per-request. A top-level `apiKey` field
  // on the constructor is NOT accepted (the implementer of Task 14 found this
  // when applying the plan and the .d.ts surface was different from what the
  // spike inferred). Without `getApiKey`, the lib silently falls back to env
  // vars.
  const agent = new Agent({
    getApiKey: () => deps.provider.apiKey,
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: getModel(deps.provider.id, deps.provider.model),
      tools,
      messages: [],
    },
    beforeToolCall: async ({ toolCall, args }) => {
      const risk: 'low' | 'medium' | 'high' =
        toolCall.name === 'see_screen' || toolCall.name === 'list_apps' ? 'low' : 'medium'
      if (risk === 'low') return undefined
      const decision = await deps.permissionClient.request({
        taskId: task.id,
        toolName: toolCall.name,
        risk,
        summary: `Run tool: ${toolCall.name}`,
        payload: args,
      })
      if (decision === 'grant') return undefined
      return { block: true, reason: `User ${decision} the action.` }
    },
  })

  const translator = createEventTranslator(task.id, deps.send)
  agent.subscribe((e) => translator.handle(e))

  try {
    await agent.prompt(task.goal)
  } catch (err) {
    deps.send({
      type: 'task.error',
      taskId: task.id,
      error: {
        code: 'agent_exception',
        message: err instanceof Error ? err.message : String(err),
        tier: 'fatal',
      },
    })
  }
}
```

### Path B — migrate to `@ai-sdk/*` (only if spike says `pi-ai` lacks apiKey option)

- [ ] **Step B1: Add deps**

Run: `pnpm add @ai-sdk/anthropic @ai-sdk/openai ai`

- [ ] **Step B2: Add to `ESM_ONLY_BUNDLE_INLINE` in `electron.vite.config.ts`** if these packages are ESM-only (verify with `cat node_modules/@ai-sdk/anthropic/package.json | grep -A4 exports`). If they are, append `'@ai-sdk/anthropic'`, `'@ai-sdk/openai'`, `'ai'` to the set.

- [ ] **Step B3: Rewrite `pi-agent/index.ts` Agent construction**

Replace the `model: getModel(...)` line with provider-conditional creation:

```ts
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'

function makeModel(p: ProviderInjection) {
  if (p.id === 'anthropic') {
    return createAnthropic({ apiKey: p.apiKey })(p.model)
  }
  return createOpenAI({ apiKey: p.apiKey })(p.model)
}

// In the Agent constructor:
model: makeModel(deps.provider),
```

Remove the `getModel` import and the `@earendil-works/pi-ai` dependency if no longer used elsewhere.

- [ ] **Step 3: Run, see them pass (both paths)**

Run: `pnpm vitest run src/worker/pi-agent`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/worker/pi-agent
git commit -m "feat(worker): pi-agent reads key/model from injection (no env)"
```

---

## Task 15: Preload — expose `window.swarm.providers.*`

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Replace the swarm object with the extended bridge**

Replace the body of `src/preload/index.ts` (keep the imports and the `process.contextIsolated` block; only change the `swarm` construction and add channel constants):

```ts
import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, ipcRenderer } from 'electron'

import type {
  PermissionDecision,
  ProvidersBridge,
  ProvidersSetResult,
  ProvidersStateView,
  ProvidersTestResult,
  SubmitGoalResult,
  SwarmBridge,
  UIEvent,
} from '../shared/types/ui'
import type { ProviderId } from '../shared/types/provider'

const IPC_EVENT_CHANNEL = 'swarm:event'
const ACCENT_CHANGE_CHANNEL = 'system:accentChange'
const PROVIDERS_STATE_CHANNEL = 'providers:stateChanged'
const PROVIDERS_DECRYPT_FAILED_CHANNEL = 'providers:decryptFailed'

const providers: ProvidersBridge = {
  get: () => ipcRenderer.invoke('providers:get') as Promise<ProvidersStateView>,
  setKey: (p: ProviderId, key: string) =>
    ipcRenderer.invoke('providers:setKey', p, key) as Promise<ProvidersSetResult>,
  clearKey: (p: ProviderId) =>
    ipcRenderer.invoke('providers:clearKey', p) as Promise<ProvidersSetResult>,
  setActive: (p: ProviderId | null) =>
    ipcRenderer.invoke('providers:setActive', p) as Promise<ProvidersSetResult>,
  setModel: (p: ProviderId, model: string) =>
    ipcRenderer.invoke('providers:setModel', p, model) as Promise<ProvidersSetResult>,
  test: (p: ProviderId) =>
    ipcRenderer.invoke('providers:test', p) as Promise<ProvidersTestResult>,
  onStateChanged: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: ProvidersStateView): void =>
      cb(payload)
    ipcRenderer.on(PROVIDERS_STATE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(PROVIDERS_STATE_CHANNEL, listener)
    }
  },
  onDecryptFailed: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on(PROVIDERS_DECRYPT_FAILED_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(PROVIDERS_DECRYPT_FAILED_CHANNEL, listener)
    }
  },
}

const swarm: SwarmBridge = {
  submitGoal: (goal) => ipcRenderer.invoke('swarm:submitGoal', goal) as Promise<SubmitGoalResult>,
  cancelTask: (taskId) => ipcRenderer.invoke('swarm:cancelTask', taskId) as Promise<void>,
  decidePermission: (actionId, decision: PermissionDecision) =>
    ipcRenderer.invoke('swarm:decidePermission', actionId, decision) as Promise<void>,
  subscribeEvents: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: UIEvent): void => cb(payload)
    ipcRenderer.on(IPC_EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, listener)
    }
  },
  getAccent: () => ipcRenderer.invoke('system:getAccent') as Promise<string | null>,
  onAccentChange: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { hex: string }): void =>
      cb(payload.hex)
    ipcRenderer.on(ACCENT_CHANGE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(ACCENT_CHANGE_CHANNEL, listener)
    }
  },
  showConfirm: (req) =>
    ipcRenderer.invoke('system:showConfirm', req) as Promise<'grant' | 'deny' | 'skip'>,
  openSettings: (opts) => ipcRenderer.invoke('system:openSettings', opts) as Promise<void>,
  providers,
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('swarm', swarm)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error — populated for non-isolated contexts (dev fallback)
  window.electron = electronAPI
  // @ts-expect-error — populated for non-isolated contexts (dev fallback)
  window.swarm = swarm
}

window.addEventListener('DOMContentLoaded', () => {
  document.body.spellcheck = false
})

window.addEventListener('DOMContentLoaded', () => {
  const s = document.createElement('span')
  s.setAttribute('aria-hidden', 'true')
  s.style.cssText =
    'position:absolute;left:-9999px;top:0;opacity:0;pointer-events:none'
  s.textContent = '😀🎉✨📦🚀 中文 日本語 한국어 ∑∫√ ✓✗'
  document.body.appendChild(s)
  void s.getBoundingClientRect()
  requestAnimationFrame(() => requestAnimationFrame(() => s.remove()))
})
```

- [ ] **Step 2: Typecheck both sides**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(preload): expose window.swarm.providers.* bridge"
```

---

## Task 16: Renderer hook `useProviders`

**Files:**
- Create: `src/renderer/src/hooks/use-providers.ts`

- [ ] **Step 1: Implement the hook**

```ts
// src/renderer/src/hooks/use-providers.ts
import { useEffect, useMemo, useState } from 'react'

import type { ProvidersStateView } from '@shared/types/provider'

const EMPTY: ProvidersStateView = {
  active: null,
  providers: { anthropic: null, openai: null },
}

export type UseProviders = {
  state: ProvidersStateView
  ready: boolean
  decryptFailed: boolean
}

export function useProviders(): UseProviders {
  const [state, setState] = useState<ProvidersStateView>(EMPTY)
  const [decryptFailed, setDecryptFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.swarm.providers.get().then((v) => {
      if (!cancelled) setState(v)
    })
    const offState = window.swarm.providers.onStateChanged((v) => setState(v))
    const offDecrypt = window.swarm.providers.onDecryptFailed(() => setDecryptFailed(true))
    return () => {
      cancelled = true
      offState()
      offDecrypt()
    }
  }, [])

  const ready = useMemo(() => {
    if (!state.active) return false
    const row = state.providers[state.active]
    return row !== null && row.hasKey === true
  }, [state])

  return { state, ready, decryptFailed }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck:web`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/hooks/use-providers.ts
git commit -m "feat(renderer): useProviders hook with ready flag"
```

---

## Task 17: Settings — add Providers tab + skeleton route

**Files:**
- Modify: `src/renderer/src/routes-settings/__root.tsx`
- Create: `src/renderer/src/routes-settings/providers.tsx`

- [ ] **Step 1: Add `Providers` to TABS at index 0**

Replace the TABS array in `src/renderer/src/routes-settings/__root.tsx`:

```ts
const TABS = [
  { to: '/providers', label: 'Providers' },
  { to: '/', label: 'General' },
  { to: '/permissions', label: 'Permissions' },
  { to: '/about', label: 'About' },
] as const
```

- [ ] **Step 2: Create a route shell that imports the view**

Create `src/renderer/src/routes-settings/providers.tsx`:

```ts
import { createFileRoute } from '@tanstack/react-router'

import { ProvidersView } from '@/components/views/providers-view'

export const Route = createFileRoute('/providers')({ component: ProvidersView })
```

- [ ] **Step 3: Regenerate the route tree by running the dev server briefly**

Run: `pnpm dev` in another terminal, wait until the renderer reports `route tree updated`, then kill it. (TanStack's `TanStackRouterVite` plugin watches `routes-settings/` and regenerates `routeTreeSettings.gen.ts`.)

Verify with: `grep providers src/renderer/src/routeTreeSettings.gen.ts | head -5`
Expected: at least one match referencing the providers route.

- [ ] **Step 4: Commit (placeholder view will be added in Task 18; for now stub it)**

Create a temporary placeholder `src/renderer/src/components/views/providers-view.tsx`:

```tsx
export function ProvidersView(): React.JSX.Element {
  return (
    <div className="max-w-2xl space-y-4">
      <h2 className="text-lg font-medium">Providers</h2>
      <p className="text-sm text-muted-foreground">UI under construction.</p>
    </div>
  )
}
```

Run: `pnpm typecheck:web`
Expected: PASS.

```bash
git add src/renderer/src/routes-settings/__root.tsx src/renderer/src/routes-settings/providers.tsx src/renderer/src/components/views/providers-view.tsx src/renderer/src/routeTreeSettings.gen.ts
git commit -m "feat(renderer): Providers tab scaffold (first tab in Settings)"
```

---

## Task 18: Providers tab — full UI

**Files:**
- Modify: `src/renderer/src/components/views/providers-view.tsx` (replace placeholder)

- [ ] **Step 1: Implement the full view**

Replace `src/renderer/src/components/views/providers-view.tsx`:

```tsx
import { useState } from 'react'

import type { ProviderId } from '@shared/types/provider'
import type { ProvidersStateView, ProvidersTestResult } from '@shared/types/ui'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useProviders } from '@/hooks/use-providers'

const ANTHROPIC_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
] as const
const OPENAI_MODELS = ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'] as const

const MODEL_OPTIONS: Record<ProviderId, readonly string[]> = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
}

const LABEL: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
}

export function ProvidersView(): React.JSX.Element {
  const { state, decryptFailed } = useProviders()

  return (
    <div className="max-w-2xl space-y-6">
      {decryptFailed && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          Saved keys could not be decrypted on this machine. Re-enter them to continue.
        </div>
      )}

      <div>
        <h2 className="text-lg font-medium">Providers</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure provider API keys. Keys are encrypted at rest using the system Keychain.
        </p>
      </div>

      <ActiveProvider state={state} />

      <hr className="border-border" />

      <ProviderRow id="anthropic" state={state} />

      <hr className="border-border" />

      <ProviderRow id="openai" state={state} />
    </div>
  )
}

function ActiveProvider({ state }: { state: ProvidersStateView }): React.JSX.Element {
  const onChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.value as ProviderId
    void window.swarm.providers.setActive(next)
  }
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Active provider</div>
      <div className="flex gap-4">
        {(['anthropic', 'openai'] as const).map((p) => (
          <label key={p} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="active-provider"
              value={p}
              checked={state.active === p}
              onChange={onChange}
            />
            {LABEL[p]}
          </label>
        ))}
      </div>
    </div>
  )
}

function ProviderRow({
  id,
  state,
}: {
  id: ProviderId
  state: ProvidersStateView
}): React.JSX.Element {
  const row = state.providers[id]
  const hasKey = row?.hasKey ?? false
  const currentModel = row?.model ?? MODEL_OPTIONS[id][0]
  const [draftKey, setDraftKey] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProvidersTestResult | null>(null)

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    const r = await window.swarm.providers.setKey(id, draftKey)
    setSaving(false)
    if (r.ok) {
      setDraftKey('')
      return
    }
    setSaveError(r.message)
  }

  const clear = async (): Promise<void> => {
    const decision = await window.swarm.showConfirm({
      title: `Remove ${LABEL[id]} API key?`,
      message: 'This will clear the stored key from disk.',
      risk: 'medium',
      buttons: [
        { label: 'Remove', role: 'grant', destructive: true },
        { label: 'Cancel', role: 'deny' },
      ],
    })
    if (decision !== 'grant') return
    await window.swarm.providers.clearKey(id)
    setTestResult(null)
  }

  const onModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    void window.swarm.providers.setModel(id, e.target.value)
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    const r = await window.swarm.providers.test(id)
    setTesting(false)
    setTestResult(r)
  }

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">{LABEL[id]}</div>

      <div className="flex items-center gap-2">
        <label className="w-20 text-xs text-muted-foreground">API key</label>
        <Input
          type="password"
          value={draftKey}
          placeholder={hasKey ? '••••••••••••••••' : ''}
          onChange={(e) => setDraftKey(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={saving}
          className="flex-1"
        />
        <Button onClick={save} disabled={saving || draftKey.length === 0} size="sm">
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <div className="ml-22 flex items-center gap-3 text-xs">
        <span className={hasKey ? 'text-foreground' : 'text-muted-foreground'}>
          {hasKey ? 'Key set ✓' : 'Not set'}
        </span>
        {hasKey && (
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
        )}
        {saveError && <span className="text-red-500">{saveError}</span>}
      </div>

      <div className="flex items-center gap-2">
        <label className="w-20 text-xs text-muted-foreground">Model</label>
        <select
          value={currentModel}
          onChange={onModelChange}
          disabled={!hasKey}
          className="rounded border border-input bg-background px-2 py-1 text-sm"
        >
          {MODEL_OPTIONS[id].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={runTest} disabled={!hasKey || testing} size="sm" variant="outline">
          {testing ? 'Testing…' : 'Test'}
        </Button>
        {testResult && <TestStatus result={testResult} />}
        {!hasKey && !testing && (
          <span className="text-xs text-muted-foreground">— set a key first</span>
        )}
      </div>
    </div>
  )
}

function TestStatus({ result }: { result: ProvidersTestResult }): React.JSX.Element {
  if (result.ok) {
    return <span className="text-xs text-green-600">✓ {result.latencyMs} ms</span>
  }
  if (result.code === 'unauthorized') {
    return <span className="text-xs text-red-500">Invalid key</span>
  }
  if (result.code === 'rate_limited') {
    return <span className="text-xs text-amber-600">Rate-limited (key is valid)</span>
  }
  if (result.code === 'network') {
    return <span className="text-xs text-muted-foreground">Network error</span>
  }
  return (
    <span className="text-xs text-muted-foreground" title={result.message}>
      {result.message}
    </span>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck:web`
Expected: PASS.

- [ ] **Step 3: Smoke-test in dev**

Run: `pnpm dev`
- Open Settings (`⌘,`)
- Click `Providers` tab → see the layout
- Type something in the Anthropic key field, click Save → state row shows `Key set ✓`
- Click Test → see one of the four status outcomes
- Click Clear → confirm → row reverts to `Not set`
- Quit `pnpm dev`

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/views/providers-view.tsx
git commit -m "feat(renderer): Providers tab UI (key + model + test + clear)"
```

---

## Task 19: Main window — no-provider banner + ready gate

**Files:**
- Create: `src/renderer/src/components/no-provider-banner.tsx`
- Modify: `src/renderer/src/entries/main.tsx` (mount the banner)

- [ ] **Step 1: Create the banner**

```tsx
// src/renderer/src/components/no-provider-banner.tsx
import { Button } from '@/components/ui/button'
import { useProviders } from '@/hooks/use-providers'

export function NoProviderBanner(): React.JSX.Element | null {
  const { ready } = useProviders()
  if (ready) return null

  const open = (): void => {
    void window.swarm.openSettings({ initialRoute: '/providers' })
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm">
      <span>⚠ No API key configured.</span>
      <Button onClick={open} size="sm" variant="default">
        Open Settings
      </Button>
    </div>
  )
}
```

- [ ] **Step 2: Mount the banner at the top of the main shell**

Open `src/renderer/src/entries/main.tsx`. Identify the JSX tree returned at the top of the rendered app (the root component above `<RouterProvider>`), and insert `<NoProviderBanner />` as the first child of the outer flex container. Example:

```tsx
import { NoProviderBanner } from '@/components/no-provider-banner'

function MainApp(): React.JSX.Element {
  useAccent()
  return (
    <div className="flex h-full flex-col">
      <NoProviderBanner />
      <RouterProvider router={router} />
    </div>
  )
}
```

(If `MainApp` currently returns `<RouterProvider router={router} />` directly, wrap it as shown — the wrapper div must take `h-full` so the router fills the remaining space.)

- [ ] **Step 3: Wire the create-task affordance to disable when not ready**

Locate the existing task-creation entry point in the renderer. Run:

```bash
grep -rn "submitGoal" src/renderer/src
```

For each call site that triggers `submitGoal`, import `useProviders` and disable the relevant button when `!ready`. Pattern:

```tsx
const { ready } = useProviders()
// ...
<Button onClick={onCreate} disabled={!ready} title={!ready ? 'Configure a provider to start tasks' : undefined}>
  Create task
</Button>
```

If the renderer currently calls `submitGoal` from a non-button surface (e.g., an Enter-key handler in `tasks-view.tsx`), add an early-return guard at the top of the handler: `if (!ready) return`.

- [ ] **Step 4: Typecheck + smoke test**

Run: `pnpm typecheck:web`
Expected: PASS.

Run: `pnpm dev` and:
- With no `providers.enc` configured → main window shows the banner; task creation is disabled
- Click `Open Settings` → Settings window opens directly on Providers tab
- Add a key + set Active → banner disappears; task creation enabled

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/no-provider-banner.tsx src/renderer/src/entries/main.tsx src/renderer/src/components/views
git commit -m "feat(renderer): no-provider banner + ready gate on task entry"
```

---

## Task 20: Final verification

**Files:** None modified — verification only.

- [ ] **Step 1: Run the full `verify` script**

Run: `pnpm verify`
Expected: PASS — typecheck (node + web), biome lint, all vitest tests, plus the `check-native-feel.ts` audit.

- [ ] **Step 2: Manual acceptance checklist (spec §6.2)**

Launch with no `providers.enc`:
```bash
rm -f "$HOME/Library/Application Support/swarm-agents/providers.enc"
pnpm dev
```

- [ ] Main window shows the no-provider banner; task creation is disabled
- [ ] Banner → `Open Settings` lands on Providers tab
- [ ] Enter Anthropic key → `Save` → row shows `Key set ✓`
- [ ] Switch Active → Anthropic; main-window banner disappears, task entry enabled
- [ ] Click `Test` → returns latency
- [ ] Replace key with garbage `xxx` → Save → Test → shows `Invalid key`
- [ ] Quit (`⌘Q`) and relaunch → key persists; main window comes up `ready`
- [ ] Click `Clear` on the Anthropic row → confirm native dialog → row reverts to `Not set`; banner reappears
- [ ] Corrupt the encrypted file:
  ```bash
  printf 'garbage' > "$HOME/Library/Application Support/swarm-agents/providers.enc"
  ```
  Relaunch → Providers tab shows the amber alert; state is empty; re-entering keys recovers without manual file deletion

- [ ] **Step 3: Document any failures inline**

If any step fails, capture the symptom in a new section at the bottom of this plan (`## Verification Failures`) and address before considering the block done.

- [ ] **Step 4: Final commit (only if any small fixes were made during verification)**

If verification surfaced minor issues that you fixed, commit them. Otherwise, no commit is needed for this task.

---

## Spike Results

**Date:** 2026-05-25
**Decision:** [x] keep `pi-ai` / [ ] migrate to `@ai-sdk/*`

**Evidence:**
- `getModel` signature: `export declare function getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(provider: TProvider, modelId: TModelId): Model<ModelApi<TProvider, TModelId>>;`
- Accepts apiKey option: no (the `getModel` function itself is strict 2-arity — no options parameter exists at the type level. Runtime spike `getModel('anthropic', 'claude-sonnet-4-5', { apiKey: 'test-fake-key' } as never)` silently dropped the third arg and returned a normal `Model` object with keys `[id, name, api, provider, baseUrl, reasoning, input, cost, contextWindow, maxTokens]` — no `apiKey` field is carried on the model.)
- However, `apiKey` IS supported one layer up: `StreamOptions.apiKey?: string` (pi-ai `dist/types.d.ts:32`) is consumed by every per-request stream call, and `pi-agent-core`'s `AgentLoopConfig extends SimpleStreamOptions` (`dist/types.d.ts:113`) inherits it. So we keep `getModel('anthropic', 'claude-sonnet-4-5')` as a pure model descriptor and inject `apiKey` via the `Agent` config / per-`prompt` options at runtime instead of `process.env.ANTHROPIC_API_KEY`.
- If no, fallback plan: use `@ai-sdk/anthropic` createAnthropic({ apiKey }) and `@ai-sdk/openai` createOpenAI({ apiKey }) per parent spec §4.3 — **not needed**; pi-ai's streaming layer accepts apiKey, so Path A is sufficient.

**Implications for downstream tasks:**
- Task 13 (worker/handler.ts): unchanged either way (just passes provider through)
- Task 14 (worker/pi-agent/index.ts): no new deps; replace `process.env.ANTHROPIC_API_KEY` read with the injected provider's `apiKey`, and pass it through `Agent` config (which extends `SimpleStreamOptions`). Same applies for the openai provider when added — `getModel('openai', '<model-id>')` + `apiKey` in stream options.
