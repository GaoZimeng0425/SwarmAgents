# Settings 样式统一 + per-model 元数据 + OpenRouter 拉取

Date: 2026-06-24
Status: Approved (design)

## 背景与目标

三个相互关联的需求：

1. **统一 settings 各 tab 的样式**（只统一布局，不动文案）。8 个 view 当前各写各的容器宽度、间距、标题字号、内边距，且 skills/mcp 还叠了双层 `p-6`。
2. **每个模型有自己的上下文 size**（仅自定义供应商）。当前 `contextWindow` 是供应商级的单值，只作用于选中的模型。
3. **用 OpenRouter `/api/v1/models` 拉取模型详情（context 长度 + 价格）**，价格接入实时成本计算。

三者耦合点：OpenRouter 的 `/models` 同时返回 context length 与价格，天然给「每模型上下文 + 单价」自动填值；pi-ai 已能从 `Model.cost` 自动算成本，所以价格写进模型即接通实时成本。

## 已确认的决策

- **语言**：只统一布局，文案完全不动（providers 仍中文，其余 6 个仍英文）。
- **OpenRouter 用法**：「拉取」按钮放在 **provider 外层**，一键拉取该供应商**所有模型**的 context + 价格。
- **per-model context 适用范围**：**仅自定义供应商**。内置 Anthropic/OpenAI 继续从 pi-ai 注册表读真实能力。
- **价格接入实时成本计算**：是。
- **未匹配模型**：OpenRouter 目录里找不到的模型，允许用户手动填上下文大小。

## 范围之外

- OpenRouter 作为独立内置 provider（仍只作元数据来源）。
- 内置供应商的 per-model context 覆写（按「仅自定义」决策）。
- 手动录入价格（价格只能通过 OpenRouter 拉取得到）。

---

## Task 1 — 布局统一

### 新增组件

`src/renderer/src/components/views/settings-header.tsx`：

```tsx
export function SettingsHeader({ title, description }: {
  title: React.ReactNode
  description?: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <h2 className="font-semibold text-lg">{title}</h2>
      {description && <p className="mt-1 text-muted-foreground text-sm">{description}</p>}
    </div>
  )
}
```

### 各 view 改造

基准规格（已被 budgets/web-search 采用）：外层容器 `max-w-2xl space-y-6`。

- **about / general / permissions**：`max-w-xl` → `max-w-2xl`，间距 → `space-y-6`，顶部 `<h2>+<p>` 换 `<SettingsHeader>`。
- **budgets / web-search**：仅把顶部块换成 `<SettingsHeader>`（已是基准规格）。
- **skills / mcp-servers**：删除各自的 `mx-auto … p-6`（与 dialog 外层 `p-6` 重复）和 `font-semibold text-xl` 标题块，外层改 `max-w-2xl space-y-6`（用 `space-y` 而非 `flex flex-col gap`，保持一致），顶部换 `<SettingsHeader>`。
- **providers**：保留宽幅 master-detail 布局（不套 `max-w-2xl`），仅把右上角中文标题块换用 `<SettingsHeader>`（文案保持中文）。

> dialog 外层 `ScrollArea > div.p-6` 不变；所有 view 不再自带外层 padding。

---

## Task 2 — per-model 元数据（仅自定义供应商）

### 数据模型（schema v4）

在 `src/shared/types/provider.ts`：

```ts
// USD / 1M tokens（与 pi-ai Model.cost 单位一致）
const ModelPricing = z.object({
  inputPerM: z.number().nonnegative(),
  outputPerM: z.number().nonnegative(),
  cacheReadPerM: z.number().nonnegative().optional(),
  cacheWritePerM: z.number().nonnegative().optional(),
})
export type ModelPricing = z.infer<typeof ModelPricing>

const ModelMeta = z.object({
  contextWindow: ContextWindow.optional(),
  pricing: ModelPricing.optional(),
})
export type ModelMeta = z.infer<typeof ModelMeta>

// On-disk Provider:
//   - 去掉供应商级 contextWindow
//   - 新增 modelMeta（仅自定义供应商写入）
modelMeta: z.record(ModelString, ModelMeta).optional()
```

`ProvidersStateOnDisk.version` 升到 `4`。

### 迁移 v3 → v4

```ts
function migrateV3ToV4(v3): ProvidersStateOnDisk {
  providers = v3.providers.map((p) => {
    const { contextWindow, ...rest } = p
    if (p.registry || contextWindow == null) return rest        // 内置或无旧值：仅去掉 contextWindow
    return { ...rest, modelMeta: { [p.model]: { contextWindow } } }  // 自定义：折进当前模型
  })
  return { version: 4, active: v3.active, providers }
}
```

`parsePersistedState` 链路：v4 直接解析；否则 v3→v4 / v2→v3→v4 / v1→…→v4。

### Renderer 投影 / 注入

- `ProviderView` 新增 `modelMeta?: Record<string, ModelMeta>`（`toView`/redact.ts 透传，不含敏感信息）。
- `ProviderInjection` 新增 `pricing?: ModelPricing`。
- `getInjection`：`contextWindow` 与 `pricing` 取自 `p.modelMeta?.[p.model]`。

### service 方法（service.ts + ipc.ts + preload + ui.ts）

- 移除 `setContextWindow(id, n)`，替换为 `setModelContextWindow(id, model, n | null)`：仅自定义供应商；`null` 删除该模型的 contextWindow（modelMeta 项空了则一并删除）。
- 新增 `mergeModelMeta(id, Record<modelId, ModelMeta>)`：批量合并（拉取写入用），一次 persist + 一次广播。合并语义：传入 meta 中存在的字段覆盖旧值（拉取视为权威，会覆盖用户手填的 contextWindow），未传入的字段保留；某模型不在传入 map 中则其原 meta 完全不变。

---

## 实时成本接入

`src/service/session/agent-runner.ts`：

```ts
function cloneTemplate(template, p, style, contextWindow) {
  const { compat: _drop, ...rest } = template
  return {
    ...rest,
    id: p.model,
    baseUrl: p.baseUrl ?? template.baseUrl,
    api: API_FOR_STYLE[style],
    ...(contextWindow != null ? { contextWindow } : {}),
    ...(p.pricing
      ? { cost: {
            input: p.pricing.inputPerM,
            output: p.pricing.outputPerM,
            cacheRead: p.pricing.cacheReadPerM ?? 0,
            cacheWrite: p.pricing.cacheWritePerM ?? 0,
          } }
      : {}),
  }
}
```

pi-ai 的 `calculateCost(model, usage)` 自动用 `Model.cost` 算出 `usage.cost.total`，agent-runner 现有的 `used.usdCents += Math.round(usage.cost.total * 100)` 无需改动。Budgets 里的 USD 上限随之对自定义模型生效。

> 注：`p.pricing` 仅自定义供应商可能有；内置走 pi-ai 注册表，不传 pricing，保持原行为。

---

## Task 3 — OpenRouter「拉取」

### 拉取模块

`src/main/providers/openrouter.ts`：

```ts
type OpenRouterModelInfo = { contextWindow?: number; pricing?: ModelPricing }

// 进程内缓存 + TTL（1h）。GET https://openrouter.ai/api/v1/models
async function fetchCatalog(): Promise<Map<string, OpenRouterModelInfo>>

// 精确 id 匹配；否则按 `vendor/` 后缀匹配（自定义模型 id 常省略前缀）
function lookupModel(catalog, modelId): OpenRouterModelInfo | null
```

- OpenRouter 响应：`data: [{ id, context_length, pricing: { prompt, completion, input_cache_read?, input_cache_write? } }]`。
- 价格字段是「USD / token」字符串：`prompt → inputPerM`、`completion → outputPerM`（× 1e6），`input_cache_read/write` 若存在则映射到 `cacheReadPerM/cacheWritePerM`。
- `context_length → contextWindow`。
- 防御式解析：缺字段/非数字则跳过该字段，不抛。

### IPC

`providers:fetchModelInfo(id)`（main 内编排，service 保持纯状态）：

1. `fetchCatalog()`（网络，可能失败 → 返回 `{ ok:false, code:'network', message }`）。
2. 取该 provider 的 `models`，逐个 `lookupModel`，构建 `Record<modelId, ModelMeta>`。
3. `service.mergeModelMeta(id, map)`（仅自定义；内置返回 invalid）。
4. 返回 `{ ok:true, matched:number, total:number, unmatched:string[] }`。

按项目日志规范：入口 info（`{ msg:'fetch model info', id }`）、结果 info（`matched/total`）、catch error、未匹配 warn。

preload + `ui.ts` 增加对应签名。

### UI（providers-view.tsx）

`ProviderDetail`（仅自定义供应商显示）：

- 模型列表区上方加一个按钮 **「从 OpenRouter 拉取」**（拉取中转圈禁用）。点击 → `fetchModelInfo(id)`，完成后 toast：「匹配 N/M 个模型；未匹配：a, b」。
- 每个模型行：
  ```
  ( ) claude-3.5-sonnet        200K · $3 / $15      [🗑]
  ```
  - context chip 行内可编辑（点击变 input，复用 `NameHeader` 的 inline-edit 模式）→ `setModelContextWindow(id, model, n|null)`。应对 OpenRouter 不存在的模型。
  - 价格 chip 仅展示（来自 `modelMeta[model].pricing`，无则不显示）。
- 删除原独立的 `ContextWindowField`（context 已下沉到每行）。

---

## 测试

- `provider.ts`：v3→v4 迁移单测（自定义带 contextWindow → modelMeta；内置不受影响；v1/v2 链路仍通）。
- `service.test.ts`：`setModelContextWindow`（自定义可设/清；内置拒绝）、`mergeModelMeta`（批量合并、未知 id 拒绝）、`getInjection` 带出当前模型的 contextWindow + pricing。
- `openrouter.ts`：catalog 解析（价格字符串换算、缺字段跳过）、`lookupModel` 精确/后缀匹配。
- `agent-runner`：注入带 pricing 时 `cloneTemplate` 覆写 `cost`（若现有测试覆盖 resolveModel 则补一条）。

## 影响面

- 改动文件：`src/shared/types/provider.ts`、`src/shared/types/ui.ts`、`src/main/providers/{service,ipc,redact}.ts`、新增 `src/main/providers/openrouter.ts`、`src/preload/index.ts`、`src/service/session/agent-runner.ts`、`src/renderer/src/components/views/*.tsx`、新增 `settings-header.tsx`、`src/renderer/src/hooks/use-providers.ts`（若类型引用）。
- 数据迁移：v3→v4，向后兼容，旧数据自动升级。
