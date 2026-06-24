# Settings 样式统一 + per-model 元数据 + OpenRouter 拉取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一 settings 各 tab 样式（以 providers tab 为基准），让每个自定义模型有独立的上下文窗口与价格，并能从 OpenRouter 一键拉取这些元数据、价格接入实时成本计算。

**Architecture:** 数据模型从 v3（供应商级 contextWindow）迁移到 v4（per-model `modelMeta` 含 contextWindow + pricing，仅自定义供应商）。main 进程新增 OpenRouter 目录拉取模块；IPC 编排「拉取 → 匹配 → 批量写入」。pricing 经 `ProviderInjection` 注入到 `cloneTemplate` 的 `Model.cost`，pi-ai 自动算出 `usage.cost`。UI 把 context/price 下沉到每个模型行，并把样式 helper 提升为共享原语。

**Tech Stack:** Electron + TypeScript + React + zod + vitest（经 `electron node` 运行）+ Biome + pi-ai/pi-agent-core。

## Global Constraints

- 回复用中文；**代码注释和 commit message 一律英文**。
- 业务路径必须打结构化日志（pino，`createLogger({process}).child({component})`）：入口 info、结果 info（含关键 shape）、每个 catch error、分支意外 warn。绝不吞异常。
- 测试用 `npm test`（即 `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`），**禁止** `pnpm rebuild better-sqlite3`。
- Biome 范围化格式化：用 `npx biome check --write <file>`（`pnpm check`/`format` 会重排整库）。
- 类型检查：`npm run typecheck`（node + web 两侧）。
- 数据迁移必须向后兼容：v1/v2/v3 旧数据自动升到 v4。
- pi-ai `Model.cost.{input,output,cacheRead,cacheWrite}` 单位为 **USD / 1M tokens**；ModelPricing 同单位。
- 仅**自定义供应商**（`registry === undefined`）支持 per-model 元数据；内置（anthropic/openai）走 pi-ai 注册表，拒绝相关写操作。

---

## File Structure

- `src/shared/types/provider.ts` — schema：新增 `ModelPricing`/`ModelMeta`，`Provider`/`ProvidersStateOnDisk` 升 v4，保留 v3 为 legacy，新增 `migrateV3ToV4`；`ProviderView` 加 `modelMeta`、去 `contextWindow`；`ProviderInjection` 加 `pricing`。
- `src/main/providers/service.ts` — 去 `setContextWindow`，加 `setModelContextWindow` + `mergeModelMeta`；`getInjection` 带出当前模型的 contextWindow + pricing。
- `src/main/providers/redact.ts` — `projectProvider` 透传 `modelMeta`、去 `contextWindow`。
- `src/main/providers/openrouter.ts` —（新）拉取 + 解析 + 匹配 OpenRouter 目录。
- `src/main/providers/ipc.ts` — 去 `setContextWindow` handler，加 `setModelContextWindow` + `fetchModelInfo` handler。
- `src/preload/index.ts` — bridge：去 `setContextWindow`，加 `setModelContextWindow` + `fetchModelInfo`。
- `src/shared/types/ui.ts` — `ProvidersBridge` 同步签名；新增 `ProvidersFetchModelInfoResult`。
- `src/service/session/agent-runner.ts` — `cloneTemplate` 用 `p.pricing` 覆写 `Model.cost`。
- `src/renderer/src/components/views/settings-primitives.tsx` —（新）`SettingsHeader` + `Section`。
- `src/renderer/src/components/views/providers-view.tsx` — 模型行展示 context/price + 行内编辑 context；provider 级「拉取」按钮；删 `ContextWindowField`；用共享原语。
- `src/renderer/src/components/views/{about,general,permissions,budgets,web-search,skills,mcp-servers}-view.tsx` — 套用共享原语统一样式。

实现顺序：Task 1（schema）→ 2（service/redact）→ 3（openrouter）→ 4（ipc/preload/ui 类型）→ 5（成本接入）→ 6（providers-view UI）→ 7（样式统一）。

---

### Task 1: schema v4 — 类型 + 迁移

**Files:**
- Modify: `src/shared/types/provider.ts`
- Test: `src/shared/types/provider.test.ts`（若不存在则创建）

**Interfaces:**
- Produces:
  - `ModelPricing = { inputPerM: number; outputPerM: number; cacheReadPerM?: number; cacheWritePerM?: number }`
  - `ModelMeta = { contextWindow?: number; pricing?: ModelPricing }`
  - `Provider`（v4）：新增 `modelMeta?: Record<string, ModelMeta>`，**移除** `contextWindow`
  - `ProvidersStateOnDisk`（v4，`version: 4`）
  - `ProviderView`：新增 `modelMeta?: Record<string, ModelMeta>`，**移除** `contextWindow`
  - `ProviderInjection`：新增 `pricing?: ModelPricing`（保留 `contextWindow`，为已解析的当前模型窗口）
  - `parsePersistedState(raw, genId)` 仍返回 v4（向后兼容 v1/v2/v3）
  - `defaultProvidersStateOnDisk()` → `version: 4`

- [ ] **Step 1: 写失败测试**

在 `src/shared/types/provider.test.ts` 追加（若文件不存在，先建一个含 import 的最小文件）：

```ts
import { describe, expect, it } from 'vitest'
import { parsePersistedState, ProvidersStateOnDisk } from './provider'

const genId = () => 'fixed-id'

describe('schema v4 migration', () => {
  it('parses a native v4 state', () => {
    const raw = {
      version: 4,
      active: 'c1',
      providers: [
        {
          id: 'c1', name: 'Big', apiStyle: 'openai', apiKey: 'sk',
          models: ['glm-4'], model: 'glm-4',
          modelMeta: { 'glm-4': { contextWindow: 128000, pricing: { inputPerM: 1, outputPerM: 2 } } },
        },
      ],
    }
    const parsed = parsePersistedState(raw, genId)
    expect(parsed?.version).toBe(4)
    expect(parsed?.providers[0]?.modelMeta?.['glm-4']?.contextWindow).toBe(128000)
  })

  it('migrates v3 custom provider-level contextWindow into modelMeta[model]', () => {
    const v3 = {
      version: 3,
      active: 'c1',
      providers: [
        { id: 'c1', name: 'Big', apiStyle: 'openai', apiKey: 'sk', models: ['glm-4'], model: 'glm-4', contextWindow: 1_000_000 },
        { id: 'anthropic', name: 'Anthropic', registry: 'anthropic', apiStyle: 'anthropic', apiKey: 'sk2', models: ['claude-sonnet-4-5'], model: 'claude-sonnet-4-5' },
      ],
    }
    const parsed = parsePersistedState(v3, genId)
    expect(parsed?.version).toBe(4)
    const custom = parsed?.providers.find((p) => p.id === 'c1')
    expect(custom?.modelMeta?.['glm-4']?.contextWindow).toBe(1_000_000)
    expect((custom as Record<string, unknown>).contextWindow).toBeUndefined()
    // builtin untouched, no modelMeta
    const builtin = parsed?.providers.find((p) => p.id === 'anthropic')
    expect(builtin?.modelMeta).toBeUndefined()
  })

  it('v3 custom without contextWindow gets no modelMeta', () => {
    const v3 = { version: 3, active: null, providers: [
      { id: 'c1', name: 'Big', apiStyle: 'openai', apiKey: 'sk', models: ['m'], model: 'm' },
    ] }
    const parsed = parsePersistedState(v3, genId)
    expect(parsed?.providers[0]?.modelMeta).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/shared/types/provider.test.ts`
Expected: FAIL（`version` 不为 4 / 迁移未实现）。

- [ ] **Step 3: 实现 schema v4 + 迁移**

在 `src/shared/types/provider.ts`：

(a) 在 `DEFAULT_CONTEXT_WINDOW` 定义之后，加 pricing/meta 类型：

```ts
// Per-model pricing in USD per 1M tokens (same units as pi-ai Model.cost).
export const ModelPricing = z.object({
  inputPerM: z.number().nonnegative(),
  outputPerM: z.number().nonnegative(),
  cacheReadPerM: z.number().nonnegative().optional(),
  cacheWritePerM: z.number().nonnegative().optional(),
})
export type ModelPricing = z.infer<typeof ModelPricing>

// Per-model metadata for custom providers. Built-ins read real capabilities
// from the pi-ai registry and never populate this.
export const ModelMeta = z.object({
  contextWindow: ContextWindow.optional(),
  pricing: ModelPricing.optional(),
})
export type ModelMeta = z.infer<typeof ModelMeta>
```

(b) 把当前的 `Provider`（含 `contextWindow`）改名为 legacy v3，并新增 v4 `Provider`。即：将现有 `export const Provider = z.object({...contextWindow...})` 替换为：

```ts
// ── v3 legacy provider (provider-level contextWindow) — parsed only for migration ──
const ProviderV3 = z.object({
  id: IdString,
  name: NameString,
  registry: BuiltinProviderId.optional(),
  apiStyle: ApiStyle,
  apiKey: z.string().min(1),
  models: z.array(ModelString).min(1).max(MAX_MODELS),
  model: ModelString,
  baseUrl: BaseUrlString.optional(),
  thinkingLevel: ModelThinkingLevel.optional(),
  contextWindow: ContextWindow.optional(),
})
type ProviderV3 = z.infer<typeof ProviderV3>

const ProvidersStateOnDiskV3 = z.object({
  version: z.literal(3),
  active: z.string().nullable(),
  providers: z.array(ProviderV3).default([]),
})
type ProvidersStateOnDiskV3 = z.infer<typeof ProvidersStateOnDiskV3>

// ── On-disk shape (v4): per-model metadata replaces provider-level contextWindow ──
export const Provider = z.object({
  id: IdString,
  name: NameString,
  registry: BuiltinProviderId.optional(),
  apiStyle: ApiStyle,
  apiKey: z.string().min(1),
  models: z.array(ModelString).min(1).max(MAX_MODELS),
  model: ModelString,
  baseUrl: BaseUrlString.optional(),
  thinkingLevel: ModelThinkingLevel.optional(),
  modelMeta: z.record(ModelString, ModelMeta).optional(),
})
export type Provider = z.infer<typeof Provider>

export const ProvidersStateOnDisk = z.object({
  version: z.literal(4),
  active: z.string().nullable(),
  providers: z.array(Provider).default([]),
})
export type ProvidersStateOnDisk = z.infer<typeof ProvidersStateOnDisk>
```

(c) `rowToProvider` 的返回类型从 `Provider` 改为 `ProviderV3`（其逻辑不变，仍产出含 `contextWindow` 的旧结构）。其签名行改为：

```ts
function rowToProvider(
  id: string,
  name: string,
  registry: BuiltinProviderId | undefined,
  apiStyle: ApiStyle,
  row: z.infer<typeof ProviderRowOnDiskV2>
): ProviderV3 {
```

(d) `migrateV2ToV3` 的返回类型从 `ProvidersStateOnDisk` 改为 `ProvidersStateOnDiskV3`，并把末行 `return { version: 3, ... }` 保持不变（现在它匹配 v3 字面量类型）。

(e) 新增 v3→v4 迁移：

```ts
function migrateV3ToV4(v3: ProvidersStateOnDiskV3): ProvidersStateOnDisk {
  const providers: Provider[] = v3.providers.map((p) => {
    const { contextWindow, ...rest } = p
    // Built-ins read their real window from pi-ai; only custom rows carried a
    // meaningful provider-level override worth preserving per-model.
    if (rest.registry || contextWindow == null) return rest
    return { ...rest, modelMeta: { [rest.model]: { contextWindow } } }
  })
  return { version: 4, active: v3.active, providers }
}
```

(f) 重写 `parsePersistedState`：

```ts
export function parsePersistedState(raw: unknown, genId: () => string): ProvidersStateOnDisk | null {
  const v4 = ProvidersStateOnDisk.safeParse(raw)
  if (v4.success) return v4.data
  const v3 = ProvidersStateOnDiskV3.safeParse(raw)
  if (v3.success) return migrateV3ToV4(v3.data)
  const v2 = ProvidersStateOnDiskV2.safeParse(raw)
  if (v2.success) return migrateV3ToV4(migrateV2ToV3(v2.data))
  const v1 = ProvidersStateOnDiskV1.safeParse(raw)
  if (v1.success) return migrateV3ToV4(migrateV2ToV3(migrateV1ToV2(v1.data, genId)))
  return null
}
```

(g) `ProviderView`：移除 `contextWindow: ContextWindow.optional()` 行，新增 `modelMeta: z.record(ModelString, ModelMeta).optional()`。

(h) `ProviderInjection`：在 `contextWindow: ...` 行之后新增 `pricing: ModelPricing.optional()`。

(i) `defaultProvidersStateOnDisk` 返回 `{ version: 4, active: null, providers: [] }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/shared/types/provider.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 可能在 service.ts/redact.ts/ipc.ts 报错（它们还引用旧 `contextWindow`）——这些在后续 task 修复。**本步只需确认 `provider.ts` 自身无类型错**（错误均来自其它文件即可继续）。

- [ ] **Step 6: 提交**

```bash
npx biome check --write src/shared/types/provider.ts src/shared/types/provider.test.ts
git add src/shared/types/provider.ts src/shared/types/provider.test.ts
git commit -m "feat(provider): schema v4 with per-model modelMeta + migration"
```

---

### Task 2: service 层 — setModelContextWindow / mergeModelMeta / 注入 pricing

**Files:**
- Modify: `src/main/providers/service.ts`
- Modify: `src/main/providers/redact.ts`
- Test: `src/main/providers/service.test.ts`

**Interfaces:**
- Consumes: `Provider`, `ModelMeta`, `ModelPricing`（Task 1）
- Produces（`Service` 类型）：
  - 移除 `setContextWindow(id, n|null)`
  - `setModelContextWindow(id: string, model: string, contextWindow: number | null): Promise<SetResult>`
  - `mergeModelMeta(id: string, map: Record<string, ModelMeta>): Promise<SetResult>`
  - `getInjection()` 返回值新增 `pricing`（取自 `modelMeta[model]`）

- [ ] **Step 1: 写失败测试**

在 `src/main/providers/service.test.ts` 追加（`customRow`、`state`、`find`、`makeStore` 已存在）：

```ts
describe('per-model metadata (v4)', () => {
  it('setModelContextWindow sets and clears per-model contextWindow on custom providers', async () => {
    const store = makeStore(state({ active: 'c1', providers: [customRow] }))
    const svc = await createService({ store })
    expect(await svc.setModelContextWindow('c1', 'glm-4', 500_000)).toEqual({ ok: true })
    expect(find(svc.getState(), 'c1')?.modelMeta?.['glm-4']?.contextWindow).toBe(500_000)
    expect(await svc.setModelContextWindow('c1', 'glm-4', null)).toEqual({ ok: true })
    expect(find(svc.getState(), 'c1')?.modelMeta?.['glm-4']).toBeUndefined()
  })

  it('setModelContextWindow rejects built-ins and unknown models', async () => {
    const svc = await createService({ store: makeStore(state({ providers: [anthropic, customRow] })) })
    expect((await svc.setModelContextWindow('anthropic', 'claude-sonnet-4-5', 1)).ok).toBe(false)
    expect((await svc.setModelContextWindow('c1', 'not-a-model', 1)).ok).toBe(false)
  })

  it('mergeModelMeta merges pulled fields, keeps untouched models, rejects built-ins', async () => {
    const row = { ...customRow, models: ['glm-4', 'glm-3'], modelMeta: { 'glm-4': { contextWindow: 1 } } }
    const svc = await createService({ store: makeStore(state({ providers: [row] })) })
    const r = await svc.mergeModelMeta('c1', {
      'glm-4': { pricing: { inputPerM: 3, outputPerM: 15 } },
      'glm-3': { contextWindow: 8000 },
      'unknown': { contextWindow: 9 }, // not in models -> ignored
    })
    expect(r.ok).toBe(true)
    const meta = find(svc.getState(), 'c1')?.modelMeta
    expect(meta?.['glm-4']).toEqual({ contextWindow: 1, pricing: { inputPerM: 3, outputPerM: 15 } })
    expect(meta?.['glm-3']).toEqual({ contextWindow: 8000 })
    expect(meta?.['unknown']).toBeUndefined()
    expect((await svc.mergeModelMeta('anthropic', {})).ok).toBe(false)
  })

  it('getInjection carries the active model contextWindow + pricing from modelMeta', async () => {
    const row = { ...customRow, modelMeta: { 'glm-4': { contextWindow: 256000, pricing: { inputPerM: 1, outputPerM: 2 } } } }
    const svc = await createService({ store: makeStore(state({ active: 'c1', providers: [row] })) })
    const inj = svc.getInjection()
    expect(inj?.contextWindow).toBe(256000)
    expect(inj?.pricing).toEqual({ inputPerM: 1, outputPerM: 2 })
  })
})
```

同时**删除/改写**现有引用旧 API 的测试：`service.test.ts` 中名为 *setContextWindow* 的用例（约 211-221 行）与 `getInjection: ... contextWindow` 用例（约 224-251 行）需改用新 API（`setModelContextWindow` / `modelMeta`）。把这两处的旧断言替换为上面的等价新断言（旧的 `setContextWindow` 调用与 `?.contextWindow` 顶层字段断言删除）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/main/providers/service.test.ts`
Expected: FAIL（`setModelContextWindow`/`mergeModelMeta` 未定义）。

- [ ] **Step 3: 实现 service 改动**

在 `src/main/providers/service.ts`：

(a) import 增加 `ModelMeta`：把 `type ModelThinkingLevel,` 一组 import 里加上 `type ModelMeta,`。

(b) 在 `Service` 类型中：删除 `setContextWindow` 那一行（及其注释），替换为：

```ts
  /** Custom providers only. Set/clear one model's context window. Pass null to clear. */
  setModelContextWindow(id: string, model: string, contextWindow: number | null): Promise<SetResult>
  /** Custom providers only. Merge pulled per-model metadata (OpenRouter). Incoming fields override. */
  mergeModelMeta(id: string, map: Record<string, ModelMeta>): Promise<SetResult>
```

(c) 在 `createService` 内、`patch` helper 之后加一个本地纯函数（设/清单个 meta 字段并裁剪空对象）：

```ts
  // Set or clear one field of one model's meta, pruning emptied objects so a
  // cleared field never leaves a dangling {} (and an empty modelMeta is dropped).
  const withMetaField = (p: Provider, model: string, contextWindow: number | null): Provider => {
    const meta: Record<string, ModelMeta> = { ...(p.modelMeta ?? {}) }
    const cur: ModelMeta = { ...(meta[model] ?? {}) }
    if (contextWindow == null) delete cur.contextWindow
    else cur.contextWindow = contextWindow
    if (cur.contextWindow == null && cur.pricing == null) delete meta[model]
    else meta[model] = cur
    if (Object.keys(meta).length === 0) {
      const { modelMeta: _omit, ...rest } = p
      return rest
    }
    return { ...p, modelMeta: meta }
  }
```

(d) `getInjection`：在构造返回对象前取 meta，并加入 contextWindow/pricing：

```ts
    getInjection: () => {
      if (!state.active) return null
      const p = find(state.active)
      if (!p) return null
      const meta = p.modelMeta?.[p.model]
      return {
        id: p.id,
        ...(p.registry ? { registry: p.registry } : {}),
        apiStyle: p.apiStyle,
        model: p.model,
        apiKey: p.apiKey,
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        ...(p.thinkingLevel ? { thinkingLevel: p.thinkingLevel } : {}),
        ...(meta?.contextWindow ? { contextWindow: meta.contextWindow } : {}),
        ...(meta?.pricing ? { pricing: meta.pricing } : {}),
      }
    },
```

(e) 删除旧 `setContextWindow` 方法（约 255-269 行），替换为：

```ts
    async setModelContextWindow(id, model, contextWindow) {
      const p = find(id)
      if (!p) return invalid(`no provider configured for "${id}"`)
      if (!isCustom(p)) return invalid('contextWindow only applies to custom providers')
      if (!p.models.includes(model)) return invalid(`model "${model}" not in provider "${id}"`)
      if (
        contextWindow !== null &&
        (!Number.isInteger(contextWindow) || contextWindow <= 0 || contextWindow > 10_000_000)
      )
        return invalid('contextWindow must be a positive integer ≤ 10,000,000')
      return persist(replaceProvider(id, withMetaField(p, model, contextWindow)))
    },

    async mergeModelMeta(id, map) {
      const p = find(id)
      if (!p) return invalid(`no provider configured for "${id}"`)
      if (!isCustom(p)) return invalid('modelMeta only applies to custom providers')
      const meta: Record<string, ModelMeta> = { ...(p.modelMeta ?? {}) }
      for (const [model, incoming] of Object.entries(map)) {
        if (!p.models.includes(model)) continue // ignore models not in the list
        meta[model] = { ...(meta[model] ?? {}), ...incoming }
      }
      return persist(replaceProvider(id, { ...p, modelMeta: meta }))
    },
```

(f) 在 `src/main/providers/redact.ts` 的 `projectProvider`：把末行 `...(p.contextWindow ? { contextWindow: p.contextWindow } : {}),` 替换为 `...(p.modelMeta ? { modelMeta: p.modelMeta } : {}),`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/main/providers/service.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
npx biome check --write src/main/providers/service.ts src/main/providers/redact.ts src/main/providers/service.test.ts
git add src/main/providers/service.ts src/main/providers/redact.ts src/main/providers/service.test.ts
git commit -m "feat(providers): per-model context window + mergeModelMeta + inject pricing"
```

---

### Task 3: OpenRouter 拉取模块

**Files:**
- Create: `src/main/providers/openrouter.ts`
- Test: `src/main/providers/openrouter.test.ts`

**Interfaces:**
- Consumes: `ModelMeta`, `ModelPricing`（Task 1）
- Produces:
  - `type Catalog = Map<string, ModelMeta>`
  - `parseCatalog(json: unknown): Catalog`（导出，便于单测）
  - `lookupModel(catalog: Catalog, modelId: string): ModelMeta | null`
  - `fetchCatalog(force?: boolean): Promise<Catalog>`（网络 + 1h 进程内缓存）

- [ ] **Step 1: 写失败测试**

`src/main/providers/openrouter.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { lookupModel, parseCatalog } from './openrouter'

const sample = {
  data: [
    {
      id: 'anthropic/claude-3.5-sonnet',
      context_length: 200000,
      pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' },
    },
    { id: 'openai/gpt-4o', context_length: 128000, pricing: { prompt: '0.0000025', completion: '0.00001' } },
    { id: 'broken/no-price', context_length: 1000, pricing: { prompt: 'n/a', completion: 'n/a' } },
    { id: 'no-context-no-price' },
  ],
}

describe('parseCatalog', () => {
  it('converts per-token USD strings to per-1M and keeps context_length', () => {
    const cat = parseCatalog(sample)
    expect(cat.get('anthropic/claude-3.5-sonnet')).toEqual({
      contextWindow: 200000,
      pricing: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
    })
  })
  it('keeps an entry with context but unparseable price (context only)', () => {
    expect(parseCatalog(sample).get('broken/no-price')).toEqual({ contextWindow: 1000 })
  })
  it('drops entries with neither context nor price', () => {
    expect(parseCatalog(sample).has('no-context-no-price')).toBe(false)
  })
  it('tolerates malformed input', () => {
    expect(parseCatalog(null).size).toBe(0)
    expect(parseCatalog({ data: 'nope' }).size).toBe(0)
  })
})

describe('lookupModel', () => {
  const cat = parseCatalog(sample)
  it('matches exact id', () => {
    expect(lookupModel(cat, 'openai/gpt-4o')?.contextWindow).toBe(128000)
  })
  it('matches by suffix after the last slash', () => {
    expect(lookupModel(cat, 'gpt-4o')?.contextWindow).toBe(128000)
  })
  it('returns null when nothing matches', () => {
    expect(lookupModel(cat, 'totally-unknown')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/main/providers/openrouter.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 openrouter.ts**

```ts
// src/main/providers/openrouter.ts
//
// Fetches the OpenRouter model catalog and exposes per-model context window +
// pricing for the providers UI's "fetch" action. Network lives here; the
// service stays a pure state machine.
import { createLogger } from '@shared/logger'
import type { ModelMeta, ModelPricing } from '@shared/types/provider'

const log = createLogger({ process: 'main' }).child({ component: 'openrouter' })

const CATALOG_URL = 'https://openrouter.ai/api/v1/models'
const TTL_MS = 60 * 60 * 1000 // 1h
const TIMEOUT_MS = 15_000

export type Catalog = Map<string, ModelMeta>

let cache: { at: number; catalog: Catalog } | null = null

// OpenRouter prices are "USD per token" strings; pi-ai cost is "USD per 1M".
function toPerM(perToken: unknown): number | null {
  if (typeof perToken !== 'string') return null
  const n = Number(perToken)
  if (!Number.isFinite(n) || n < 0) return null
  return n * 1_000_000
}

function parsePricing(raw: unknown): ModelPricing | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const inputPerM = toPerM(r.prompt)
  const outputPerM = toPerM(r.completion)
  if (inputPerM == null || outputPerM == null) return undefined
  const cacheReadPerM = toPerM(r.input_cache_read)
  const cacheWritePerM = toPerM(r.input_cache_write)
  return {
    inputPerM,
    outputPerM,
    ...(cacheReadPerM != null ? { cacheReadPerM } : {}),
    ...(cacheWritePerM != null ? { cacheWritePerM } : {}),
  }
}

export function parseCatalog(json: unknown): Catalog {
  const out: Catalog = new Map()
  const data = (json as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return out
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string') continue
    const meta: ModelMeta = {}
    if (typeof e.context_length === 'number' && Number.isInteger(e.context_length) && e.context_length > 0)
      meta.contextWindow = e.context_length
    const pricing = parsePricing(e.pricing)
    if (pricing) meta.pricing = pricing
    if (meta.contextWindow != null || meta.pricing) out.set(e.id, meta)
  }
  return out
}

// Exact id match first, else match by the segment after the last '/' (custom
// model ids often omit the OpenRouter "vendor/" prefix).
export function lookupModel(catalog: Catalog, modelId: string): ModelMeta | null {
  const exact = catalog.get(modelId)
  if (exact) return exact
  for (const [orId, meta] of catalog) {
    if (orId.slice(orId.lastIndexOf('/') + 1) === modelId) return meta
  }
  return null
}

export async function fetchCatalog(force = false): Promise<Catalog> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.catalog
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  log.info({ msg: 'fetching openrouter catalog' })
  try {
    const res = await fetch(CATALOG_URL, { signal: ac.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const catalog = parseCatalog(await res.json())
    cache = { at: Date.now(), catalog }
    log.info({ msg: 'openrouter catalog fetched', count: catalog.size })
    return catalog
  } catch (e) {
    log.error({ msg: 'openrouter catalog fetch failed', err: e instanceof Error ? e.message : String(e) })
    throw e
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/main/providers/openrouter.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
npx biome check --write src/main/providers/openrouter.ts src/main/providers/openrouter.test.ts
git add src/main/providers/openrouter.ts src/main/providers/openrouter.test.ts
git commit -m "feat(providers): OpenRouter catalog fetch + model lookup"
```

---

### Task 4: IPC + preload + ui.ts 类型

**Files:**
- Modify: `src/main/providers/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types/ui.ts`

**Interfaces:**
- Consumes: `service.setModelContextWindow` / `service.mergeModelMeta`（Task 2）、`fetchCatalog` / `lookupModel`（Task 3）、`ModelMeta`（Task 1）
- Produces（wire 层）：
  - IPC channel `providers:setModelContextWindow`（args: id, model, contextWindow|null）
  - IPC channel `providers:fetchModelInfo`（args: id）
  - `ProvidersFetchModelInfoResult = { ok: true; matched: number; total: number; unmatched: string[] } | { ok: false; code: 'invalid' | 'network'; message: string }`
  - `ProvidersBridge`：移除 `setContextWindow`，新增 `setModelContextWindow(id, model, n|null)` 与 `fetchModelInfo(id)`

- [ ] **Step 1: ui.ts 类型**

在 `src/shared/types/ui.ts`：

(a) 在 `ProvidersTestResult` 附近新增结果类型：

```ts
export type ProvidersFetchModelInfoResult =
  | { ok: true; matched: number; total: number; unmatched: string[] }
  | { ok: false; code: 'invalid' | 'network'; message: string }
```

(b) `ProvidersBridge`：删除 `setContextWindow(id, contextWindow): Promise<ProvidersSetResult>` 一行（及其注释），新增：

```ts
  /** Custom providers only. Set/clear one model's context window. Pass null to clear. */
  setModelContextWindow(id: string, model: string, contextWindow: number | null): Promise<ProvidersSetResult>
  /** Custom providers only. Pull per-model context + pricing from OpenRouter for all models. */
  fetchModelInfo(id: string): Promise<ProvidersFetchModelInfoResult>
```

- [ ] **Step 2: ipc.ts handlers**

在 `src/main/providers/ipc.ts`：

(a) import：把 `import { type ApiStyle, ModelThinkingLevel } from '@shared/types/provider'` 行加上 `type ModelMeta`；新增 `import { fetchCatalog, lookupModel } from './openrouter'`。

(b) 删除 `providers:setContextWindow` handler（约 114-123 行），替换为：

```ts
  ipcMain.handle(
    'providers:setModelContextWindow',
    (_e: Electron.IpcMainInvokeEvent, p: unknown, model: unknown, contextWindow: unknown) => {
      const id = asId(p)
      if (!id) return badId
      if (typeof model !== 'string') return { ok: false, code: 'invalid', message: 'model must be a string' }
      if (contextWindow !== null && typeof contextWindow !== 'number')
        return { ok: false, code: 'invalid', message: 'contextWindow must be a number or null' }
      return service.setModelContextWindow(id, model, contextWindow)
    }
  )

  ipcMain.handle('providers:fetchModelInfo', async (_e: Electron.IpcMainInvokeEvent, p: unknown) => {
    const id = asId(p)
    if (!id) return { ok: false as const, code: 'invalid' as const, message: 'invalid provider id' }
    const provider = service.getState().providers.find((x) => x.id === id)
    if (!provider) return { ok: false as const, code: 'invalid' as const, message: `unknown provider "${id}"` }
    if (provider.registry)
      return { ok: false as const, code: 'invalid' as const, message: 'OpenRouter fetch applies to custom providers only' }
    log.info({ msg: 'fetch model info', id, total: provider.models.length })
    let catalog: Awaited<ReturnType<typeof fetchCatalog>>
    try {
      catalog = await fetchCatalog()
    } catch (e) {
      return { ok: false as const, code: 'network' as const, message: e instanceof Error ? e.message : String(e) }
    }
    const map: Record<string, ModelMeta> = {}
    const unmatched: string[] = []
    for (const m of provider.models) {
      const meta = lookupModel(catalog, m)
      if (meta) map[m] = meta
      else unmatched.push(m)
    }
    const r = await service.mergeModelMeta(id, map)
    if (!r.ok) return { ok: false as const, code: 'invalid' as const, message: r.message }
    if (unmatched.length) log.warn({ msg: 'models unmatched on openrouter', id, unmatched })
    const matched = provider.models.length - unmatched.length
    log.info({ msg: 'fetch model info done', id, matched, total: provider.models.length })
    return { ok: true as const, matched, total: provider.models.length, unmatched }
  })
```

(c) `channels` 数组：把 `'providers:setContextWindow'` 改为 `'providers:setModelContextWindow'`，并追加 `'providers:fetchModelInfo'`。

- [ ] **Step 3: preload bridge**

在 `src/preload/index.ts` 的 `providers` 对象：删除 `setContextWindow:` 那一行（约 60-61），替换为：

```ts
  setModelContextWindow: (id: string, model: string, contextWindow: number | null) =>
    ipcRenderer.invoke('providers:setModelContextWindow', id, model, contextWindow) as Promise<ProvidersSetResult>,
  fetchModelInfo: (id: string) =>
    ipcRenderer.invoke('providers:fetchModelInfo', id) as Promise<ProvidersFetchModelInfoResult>,
```

并确保 `ProvidersFetchModelInfoResult` 已在 preload 的 type import 中（与 `ProvidersSetResult` 同处 import）。

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: PASS（renderer 仍引用旧 `setContextWindow` 会报错——若报错仅来自 `providers-view.tsx`，可接受，将在 Task 6 修复；ipc/preload/ui.ts/service 三者应无错）。

> 若希望本步完全干净，可临时不动；Task 6 完成后整体 typecheck 必须全绿。

- [ ] **Step 5: 提交**

```bash
npx biome check --write src/main/providers/ipc.ts src/preload/index.ts src/shared/types/ui.ts
git add src/main/providers/ipc.ts src/preload/index.ts src/shared/types/ui.ts
git commit -m "feat(providers): IPC for setModelContextWindow + fetchModelInfo"
```

---

### Task 5: 实时成本接入（cloneTemplate 覆写 Model.cost）

**Files:**
- Modify: `src/main/providers/../../service/session/agent-runner.ts:72-86`
- Test: `src/service/session/agent-runner.test.ts`（若存在 resolveModel/cloneTemplate 覆盖则补一条；否则跳过测试步，仅靠 typecheck）

**Interfaces:**
- Consumes: `ProviderInjection.pricing`（Task 1）

- [ ] **Step 1: 确认是否有可用测试入口**

Run: `ls src/service/session/agent-runner.test.ts 2>/dev/null && grep -n "resolveModel\|cloneTemplate\|cost" src/service/session/agent-runner.test.ts`
- 若 `resolveModel`/`cloneTemplate` 未导出且无现成测试：跳到 Step 3（无单测，靠 typecheck + 人工验证）。
- 若可测：在 Step 2 写「注入带 pricing → 返回 model.cost 等于该 pricing」的断言。

- [ ] **Step 2:（仅当可测）写失败测试**

```ts
// 形如：
const model = resolveModel({
  id: 'c1', apiStyle: 'openai', model: 'glm-4', apiKey: 'k',
  baseUrl: 'https://x/v1', pricing: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
} as ProviderInjection)
expect(model.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 })
```

- [ ] **Step 3: 实现 cloneTemplate 覆写 cost**

在 `src/service/session/agent-runner.ts` 的 `cloneTemplate`，把 return 改为：

```ts
function cloneTemplate(
  template: Model<Api>,
  p: ProviderInjection,
  style: ApiStyle,
  contextWindow?: number
): Model<Api> {
  const { compat: _drop, ...rest } = template
  return {
    ...rest,
    id: p.model,
    baseUrl: p.baseUrl ?? template.baseUrl,
    api: API_FOR_STYLE[style],
    ...(contextWindow != null ? { contextWindow } : {}),
    // Custom-model pricing (from OpenRouter) overrides the fallback template's
    // cost so pi-ai's calculateCost() produces real per-turn cost for usdCents.
    ...(p.pricing
      ? {
          cost: {
            input: p.pricing.inputPerM,
            output: p.pricing.outputPerM,
            cacheRead: p.pricing.cacheReadPerM ?? 0,
            cacheWrite: p.pricing.cacheWritePerM ?? 0,
          },
        }
      : {}),
  }
}
```

> 注：`cloneTemplate` 只在 `resolveModel` 的自定义分支（`!p.registry`）和内置 baseUrl 覆盖分支被调用；内置注入不带 `pricing`，行为不变。

- [ ] **Step 4: 验证**

Run: `npm run typecheck`（必过）；若 Step 2 写了测试：`npm test -- src/service/session/agent-runner.test.ts`（PASS）。

- [ ] **Step 5: 提交**

```bash
npx biome check --write src/service/session/agent-runner.ts
git add src/service/session/agent-runner.ts
# 若写了测试也一并 add
git commit -m "feat(agent-runner): apply custom-model pricing to Model.cost for real usdCents"
```

---

### Task 6: providers-view UI — per-model context/price + 拉取按钮

**Files:**
- Modify: `src/renderer/src/components/views/providers-view.tsx`

**Interfaces:**
- Consumes: `ProviderView.modelMeta`（Task 1）、`window.swarm.providers.setModelContextWindow` / `fetchModelInfo`（Task 4）

- [ ] **Step 1: imports + 删除旧 ContextWindowField 引用**

在 `providers-view.tsx`：

(a) lucide import 增加 `Download`（拉取图标）：把 `import { Bot, Box, Eye, EyeOff, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'` 改为含 `Download`。

(b) 顶部新增 `import { toast } from 'sonner'`。

(c) 删除 `ProviderDetail` 中的 `{!isBuiltin && row && <ContextWindowField id={id} value={row.contextWindow} />}` 一行（约 234）。

(d) 删除 `ContextWindowField` 组件整体（约 487-506）。

- [ ] **Step 2: 给 ModelList 增加 fetch 按钮 + 行内 context/price 编辑**

把现有 `ModelList`（386-461）整体替换为下面实现（新增 `isBuiltin` 形参，新增 `ModelRow` 子组件 + 两个格式化 helper）：

```tsx
function formatContext(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

function formatPrice(p: { inputPerM: number; outputPerM: number }): string {
  const fmt = (v: number) => `$${Number(v.toFixed(2))}`
  return `${fmt(p.inputPerM)} / ${fmt(p.outputPerM)}`
}

function ModelList({ id, row, isBuiltin }: { id: string; row: ProviderView; isBuiltin: boolean }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [fetching, setFetching] = useState(false)
  const suggestions = modelSuggestionsFor(id)
  const models = row.models

  const add = async (m: string): Promise<void> => {
    if (!m.trim()) return
    await window.swarm.providers.addCustomModel(id, m.trim())
    setDraft('')
  }

  const fetchInfo = async (): Promise<void> => {
    setFetching(true)
    const r = await window.swarm.providers.fetchModelInfo(id)
    setFetching(false)
    if (!r.ok) {
      toast.error(`拉取失败：${r.message}`)
      return
    }
    const tail = r.unmatched.length ? `；未匹配：${r.unmatched.join(', ')}` : ''
    toast.success(`已匹配 ${r.matched}/${r.total} 个模型${tail}`)
  }

  return (
    <Section label="模型列表">
      {!isBuiltin && (
        <div className="flex justify-end">
          <Button disabled={fetching} onClick={() => void fetchInfo()} size="sm" variant="outline">
            <Download className={cn('size-3.5', fetching && 'animate-pulse')} />
            {fetching ? '拉取中…' : '从 OpenRouter 拉取'}
          </Button>
        </div>
      )}
      <div className="space-y-1.5">
        {models.map((m) => (
          <ModelRow
            active={row.model === m}
            id={id}
            isBuiltin={isBuiltin}
            key={m}
            meta={row.modelMeta?.[m]}
            model={m}
          />
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          list={`models-${id}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void add(draft)
            }
          }}
          placeholder="添加模型 id"
          value={draft}
        />
        <datalist id={`models-${id}`}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <Button disabled={!draft.trim()} onClick={() => void add(draft)} variant="outline">
          <Plus /> 添加模型
        </Button>
      </div>
    </Section>
  )
}

function ModelRow({
  id,
  model,
  active,
  isBuiltin,
  meta,
}: {
  id: string
  model: string
  active: boolean
  isBuiltin: boolean
  meta: { contextWindow?: number; pricing?: { inputPerM: number; outputPerM: number } } | undefined
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(meta?.contextWindow != null ? String(meta.contextWindow) : '')

  const commit = (): void => {
    setEditing(false)
    const t = draft.trim()
    if (t === '') {
      if (meta?.contextWindow != null) void window.swarm.providers.setModelContextWindow(id, model, null)
      return
    }
    const n = Number(t)
    if (Number.isInteger(n) && n > 0 && n !== meta?.contextWindow)
      void window.swarm.providers.setModelContextWindow(id, model, n)
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
        active && 'border-primary/40 bg-primary/5'
      )}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        onClick={() => void window.swarm.providers.setModel(id, model)}
        type="button"
      >
        <span
          className={cn(
            'size-3.5 shrink-0 rounded-full border',
            active ? 'border-[4.5px] border-primary' : 'border-muted-foreground/40'
          )}
        />
        <span className="truncate font-mono">{model}</span>
      </button>

      {/* Per-model context + price. Context is inline-editable for custom providers
          (so models missing from OpenRouter can be filled by hand). */}
      <div className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
        {meta?.pricing && <span className="tabular-nums">{formatPrice(meta.pricing)}</span>}
        {!isBuiltin &&
          (editing ? (
            <Input
              autoFocus
              className="h-6 w-24 text-xs"
              onBlur={commit}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') {
                  setDraft(meta?.contextWindow != null ? String(meta.contextWindow) : '')
                  setEditing(false)
                }
              }}
              placeholder="ctx"
              value={draft}
            />
          ) : (
            <button
              className="rounded px-1 hover:bg-accent hover:text-foreground"
              onClick={() => {
                setDraft(meta?.contextWindow != null ? String(meta.contextWindow) : '')
                setEditing(true)
              }}
              title="设置上下文窗口"
              type="button"
            >
              {meta?.contextWindow != null ? formatContext(meta.contextWindow) : '设置 ctx'}
            </button>
          ))}
      </div>

      {!active && (
        <button
          className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
          onClick={() => void window.swarm.providers.removeCustomModel(id, model)}
          title="移除"
          type="button"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 3: 更新 ModelList 调用处传 isBuiltin**

在 `ProviderDetail`（约 230）把 `{row && <ModelList id={id} row={row} />}` 改为 `{row && <ModelList id={id} isBuiltin={isBuiltin} row={row} />}`。

- [ ] **Step 4: 类型检查 + lint**

Run: `npm run typecheck`
Expected: PASS（此时 renderer 不再引用旧 `setContextWindow`/`row.contextWindow`，全库应全绿）。

Run: `npx biome check --write src/renderer/src/components/views/providers-view.tsx`

- [ ] **Step 5: 人工验证（run-desktop）**

启动应用（参见 run-desktop skill），打开 Settings → 模型设置，选一个自定义供应商：
- 点「从 OpenRouter 拉取」，确认 toast 显示匹配数；已知模型行出现 `context · $in/$out`。
- 点某行的「设置 ctx」/数字，输入数值回车，确认持久化（关弹窗重开仍在）。
- 内置供应商不显示「拉取」按钮、不显示行内 ctx 编辑。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/components/views/providers-view.tsx
git commit -m "feat(providers-view): per-model context/price rows + OpenRouter fetch button"
```

---

### Task 7: settings 样式统一（以 providers tab 为基准）

**Files:**
- Create: `src/renderer/src/components/views/settings-primitives.tsx`
- Modify: `src/renderer/src/components/views/providers-view.tsx`
- Modify: `src/renderer/src/components/views/about-view.tsx`
- Modify: `src/renderer/src/components/views/general-view.tsx`
- Modify: `src/renderer/src/components/views/permissions-view.tsx`
- Modify: `src/renderer/src/components/views/budgets-view.tsx`
- Modify: `src/renderer/src/components/views/web-search-view.tsx`
- Modify: `src/renderer/src/components/views/skills-view.tsx`
- Modify: `src/renderer/src/components/views/mcp-servers-view.tsx`

**Interfaces:**
- Produces: `SettingsHeader({ title, description?, action? })`、`Section({ label, children })`（自 providers-view 提升）

- [ ] **Step 1: 新建共享原语**

`src/renderer/src/components/views/settings-primitives.tsx`：

```tsx
// Shared settings-tab style primitives, lifted from providers-view so every
// tab shares one header + section visual language.

export function SettingsHeader({
  title,
  description,
  action,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="font-medium text-lg">{title}</h2>
        {description && <p className="mt-1 text-muted-foreground text-sm">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function Section({ label, children }: { label: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="font-medium text-sm">{label}</div>
      {children}
    </div>
  )
}
```

- [ ] **Step 2: providers-view 改用共享原语**

在 `providers-view.tsx`：
(a) 删除本文件内私有的 `Section` 函数（约 291-298）。
(b) 顶部 import 增加 `import { Section, SettingsHeader } from './settings-primitives'`。
(c) 把顶部的标题块（约 80-88）：

```tsx
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-medium text-lg">模型设置</h2>
          <p className="mt-1 text-muted-foreground text-sm">管理自定义模型供应商，配置后可在聊天时选择使用。</p>
        </div>
        <Button onClick={refetch} size="icon-sm" title="刷新" variant="ghost">
          <RefreshCw />
        </Button>
      </div>
```

替换为：

```tsx
      <SettingsHeader
        action={
          <Button onClick={refetch} size="icon-sm" title="刷新" variant="ghost">
            <RefreshCw />
          </Button>
        }
        description="管理自定义模型供应商，配置后可在聊天时选择使用。"
        title="模型设置"
      />
```

- [ ] **Step 3: 简单文本 tab（about / general）**

`about-view.tsx` → 改为（容器 `max-w-2xl space-y-5`，用 SettingsHeader；description 内的英文文案不变）：

```tsx
import { SettingsHeader } from './settings-primitives'

export function AboutView(): React.JSX.Element {
  return (
    <div className="max-w-2xl space-y-5">
      <SettingsHeader description="Bundle: dev.swarmagents.app · Auto-update via electron-updater." title="SwarmAgents" />
    </div>
  )
}
```

`general-view.tsx` → 同样：

```tsx
import { SettingsHeader } from './settings-primitives'

export function GeneralView(): React.JSX.Element {
  return (
    <div className="max-w-2xl space-y-5">
      <SettingsHeader description="Settings will appear here as features are added." title="General" />
    </div>
  )
}
```

- [ ] **Step 4: permissions-view**

在 `permissions-view.tsx`：
(a) import 增加 `import { Section, SettingsHeader } from './settings-primitives'`。
(b) 外层 `max-w-xl space-y-6` → `max-w-2xl space-y-5`。
(c) 把首个 `<section className="space-y-2"><h2 …>Permissions</h2><p …>…</p></section>` 替换为：

```tsx
      <SettingsHeader
        description="Default policy: prompt on medium and high. Per-tool overrides coming in a later release."
        title="Permissions"
      />
```

(d) `macOS System Access` 那段：保留其 `<h3 className="font-medium text-sm">` 与 Re-check 按钮的 `flex items-center justify-between`（它已是 `font-medium text-sm`，符合基准），无需改。

- [ ] **Step 5: budgets-view**

在 `budgets-view.tsx`：
(a) import 增加 `import { SettingsHeader } from './settings-primitives'`。
(b) 外层 `max-w-2xl space-y-6` → `max-w-2xl space-y-5`。
(c) 顶部 `<div><h2 …>Budgets</h2><p …>…</p></div>` 替换为 `<SettingsHeader>`，description 用原英文（含 `<strong>`/`<code>` 的 JSX 直接作为 description 传入）：

```tsx
      <SettingsHeader
        description={
          <>
            Per-task spending caps. A task stops once it hits any limit. <strong>Main agent</strong> applies to tasks
            you start; <strong>Sub-agent</strong> applies to each agent spawned via <code>spawn_sub_agent</code>.
          </>
        }
        title="Budgets"
      />
```

（`BudgetSection` 内的 `font-medium text-sm` 标题保留不变。）

- [ ] **Step 6: web-search-view**

在 `web-search-view.tsx`：
(a) import 增加 `import { Section, SettingsHeader } from './settings-primitives'`。
(b) 外层 `max-w-2xl space-y-6` → `max-w-2xl space-y-5`。
(c) 顶部块替换为 `<SettingsHeader>`：

```tsx
      <SettingsHeader
        description={
          <>
            Choose the backend the <code>web_search</code> tool uses. API keys are encrypted at rest using the system
            Keychain. An empty key falls back to the matching environment variable.
          </>
        }
        title="Web Search"
      />
```

(d) 把 `ProviderPicker` 内的 `<div className="font-medium text-sm">Provider</div>` 外层手写块改用 `<Section label="Provider">…</Section>`（包裹 Select + hint + error）。`KeyRow`/`SearxngUrlRow` 的 `font-medium text-sm` 标题已符合基准，保留。

- [ ] **Step 7: skills-view**

在 `skills-view.tsx`：
(a) import 增加 `import { SettingsHeader } from './settings-primitives'`。
(b) 外层 `mx-auto flex max-w-2xl flex-col gap-4 p-6` → `max-w-2xl space-y-4`（去掉 `mx-auto`、`p-6`，去掉 `flex flex-col gap-4` 改 `space-y-4`，因为列表项间距原为 gap-4）。
(c) 顶部 `<div className="flex items-start justify-between gap-4"><div><h2 …text-xl>Skills</h2><p>…</p></div><div className="flex shrink-0 gap-2">…按钮…</div></div>` 替换为：

```tsx
      <SettingsHeader
        action={
          <div className="flex shrink-0 gap-2">
            <Button className="gap-1.5" onClick={() => void window.swarm.openUserDataDir()} variant="outline">
              <FolderOpen className="size-4" />
              Open data folder
            </Button>
            <Button className="gap-1.5" onClick={() => void runImport()}>
              <FolderInput className="size-4" />
              Import skill folder
            </Button>
          </div>
        }
        description={
          <>
            Reusable instruction folders. Import a folder containing a{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">SKILL.md</code> plus any scripts or resources. The
            agent sees each skill's name + description and loads the full body on demand via the{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">use_skill</code> tool.
          </>
        }
        title="Skills"
      />
```

- [ ] **Step 8: mcp-servers-view**

在 `mcp-servers-view.tsx`：
(a) import 增加 `import { SettingsHeader } from './settings-primitives'`。
(b) 外层（约 381）`mx-auto flex max-w-2xl flex-col gap-4` → `max-w-2xl space-y-4`（去 `mx-auto`，flex→space-y）。
(c) 顶部 `<h2 className="font-semibold text-xl">MCP Servers</h2>` 所在的标题块（约 382-384 及其同级描述/按钮）改用 `<SettingsHeader>`。先 Read 该文件 380-400 区域确认顶部块的确切 JSX，再把 `<div>…<h2>MCP Servers</h2><p>…</p>…</div>`（含可能的「Add a server」按钮位置）整体替换为 `<SettingsHeader title="MCP Servers" description={…原文案…} action={…若有顶部按钮…} />`。保持文案与按钮行为不变。

> 注：mcp-servers-view 内部用了 `Tabs`、`<h3 className="font-medium text-sm">Add a server</h3>` 等，均已是 `font-medium text-sm`，符合基准，无需改。仅改最外层容器 + 顶部标题块。

- [ ] **Step 9: 类型检查 + lint**

Run: `npm run typecheck`
Expected: PASS。

Run（一次性范围化）：
```bash
npx biome check --write src/renderer/src/components/views/settings-primitives.tsx src/renderer/src/components/views/about-view.tsx src/renderer/src/components/views/general-view.tsx src/renderer/src/components/views/permissions-view.tsx src/renderer/src/components/views/budgets-view.tsx src/renderer/src/components/views/web-search-view.tsx src/renderer/src/components/views/skills-view.tsx src/renderer/src/components/views/mcp-servers-view.tsx src/renderer/src/components/views/providers-view.tsx
```

- [ ] **Step 10: 人工验证（run-desktop）**

逐个打开 8 个 settings tab，确认：标题字号/描述一致（`font-medium text-lg`），无双层 padding（skills/mcp 不再比别的窄一圈或缩进），区块标签统一 `font-medium text-sm`，providers 仍是宽幅双栏。

- [ ] **Step 11: 提交**

```bash
git add src/renderer/src/components/views/settings-primitives.tsx src/renderer/src/components/views/*-view.tsx
git commit -m "refactor(settings): unify tab styling on shared primitives (providers baseline)"
```

---

### Task 8: 全量验证

**Files:** 无（验证）

- [ ] **Step 1: 完整 verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 全 PASS。

> 不跑 `pnpm run verify` 里的 `check-native-feel` 除非本来就通过；若该脚本与本次无关失败，记录但不强行修。

- [ ] **Step 2: 迁移冒烟（人工）**

用一份旧的 v3 providers 状态（自定义供应商带 `contextWindow`）启动应用，确认：不崩、该值出现在对应模型行的 ctx 上、之后写入升级为 v4（关掉再开仍正常）。

- [ ] **Step 3: 成本冒烟（人工，可选）**

对一个已拉取到 pricing 的自定义模型跑一次任务，确认 usage 显示的 cost（usdCents）非 0 且数量级合理。

---

## Self-Review

**1. Spec coverage**
- Task 1（统一样式，providers 基准）→ Plan Task 7 + settings-primitives。✓
- Task 2（per-model context，仅自定义）→ Plan Task 1（schema）+ 2（service）+ 6（UI 行内编辑）。✓
- Task 3（OpenRouter 拉取 + 价格）→ Plan Task 3（模块）+ 4（IPC）+ 6（provider 级按钮）。✓
- 实时成本接入 → Plan Task 5。✓
- v3→v4 迁移 → Plan Task 1。✓
- 未匹配模型手动填 → Plan Task 6（ModelRow 行内编辑）。✓

**2. Placeholder scan**：无 TBD/TODO；每个改码步骤含完整代码。mcp-servers Step 8 要求先 Read 顶部块——因该文件顶部 JSX 未在本计划逐字展开，明确指示读后替换，非占位。✓

**3. Type consistency**：
- `setModelContextWindow(id, model, n|null)` 在 service/ipc/preload/ui.ts/UI 一致。✓
- `mergeModelMeta(id, Record<string, ModelMeta>)` service/ipc 一致。✓
- `ProvidersFetchModelInfoResult` 在 ui.ts 定义、preload/ipc 返回、UI 消费一致（`matched/total/unmatched`）。✓
- `ModelPricing` 字段 `inputPerM/outputPerM/cacheReadPerM?/cacheWritePerM?` 在 schema、openrouter、cloneTemplate、UI formatPrice 一致。✓
- `ProviderView.modelMeta` 在 redact 投影、UI 消费一致。✓
