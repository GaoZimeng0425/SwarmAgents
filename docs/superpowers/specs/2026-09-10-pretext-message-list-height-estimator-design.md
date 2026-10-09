# 用 @chenglou/pretext 预测 agent message list 行高 — 技术方案

Date: 2026-09-10
Status: Phase 0 done(2026-09-16,D2 已拍板:策略 B)
Scope: `apps/desktop` renderer,`ConversationThread` 的虚拟化消息列表

## 1. 背景与问题

当前消息列表链路:

```
AgentWireEvent → applyWireEvent(SessionView) → buildSegments(Segment[])
  → buildThreadItems(TimelineItem) → VirtualList(@tanstack/react-virtual)
  → Segment 渲染(Streamdown markdown / Tool 卡片 / ReasoningBlock / SubagentBlock)
```

`VirtualList`(`apps/desktop/src/renderer/src/components/viewers/virtual-list.tsx`)的现状:

- `estimateSize: () => 120` — 对所有未测量行使用**固定常数猜测**。
- 每行 `ref={virtualizer.measureElement}` — 挂载/尺寸变化后由 ResizeObserver 做 **DOM 实测**,并以实测值覆盖估计值。
- stick-to-bottom 以 `totalSize` 变化为触发,在 `useLayoutEffect` 里重新钉底。

由此产生三类真实痛点:

| # | 症状 | 根因 |
|---|------|------|
| P1 | 打开长会话 / 向上滚动时,滚动条 thumb 跳动、滚动位置漂移 | 视口外的行只有 120px 的猜测高度,实测逐行"填充"导致上方内容总高变化 |
| P2 | 流式输出时底部偶发 1 帧级抖动 | 尾行 DOM 先长高,ResizeObserver 在 paint 之后才触发 → `totalSize` 晚一帧,钉底晚一帧 |
| P3 | 每行挂载/变化都要 DOM 实测(强制同步 reflow),行数多时开销累积 | `measureElement` 本质是布局读取 |

## 2. pretext 是什么、能/不能解决什么

[`@chenglou/pretext`](https://github.com/chenglou/pretext) 是纯 JS/TS 的多行文本测量与排版库:用 Canvas 2D 作为字体度量的 ground truth,**完全不触发 DOM reflow** 地预测文本排版结果。

核心 API(本方案只用到用例 1):

```ts
// 昂贵的一次性分析:分词 + 逐字符 canvas 测宽,返回不透明句柄(与宽度无关)
prepare(text: string, font: string, options?: {
  whiteSpace?: 'normal' | 'pre-wrap'
  wordBreak?: 'normal' | 'keep-all'
  letterSpacing?: number
}): PreparedText

// 廉价热路径:纯算术,随 width 反复调用
layout(prepared: PreparedText, maxWidth: number, lineHeight: number)
  // → { height: number, lineCount: number }
```

运行时要求与硬约束(Electron 渲染进程全部满足):

- 需要 `Intl.Segmenter` + Canvas 2D。
- 仅支持 `white-space: normal | pre-wrap`、`word-break: normal | keep-all`。
- **macOS 上 `system-ui` / `-apple-system` 用于测量"不安全"**,必须用具名字体。
- 空字符串 `layout()` 返回 `height: 0`(浏览器实际渲染一行),需 `Math.max(1, lineCount)` 钳制。
- 未建模:`font-optical-sizing`、`font-feature-settings`、独立 `font-variation-settings`;tab 按 `tab-size: 8`。

**能解决**:P1(未测量行的估计从"常数 120"升级为"接近精确值",滚动数学第一次就基本正确)、P2(配合推送路径,尾行高度可以在 paint 前就正确)、P3 的文本行部分(估计阶段零 DOM 读取)。

**不能解决(明确非目标)**:

- Streamdown 每个流式 delta 对整段 markdown 的重新解析(CPU 大头之一,与本方案正交)。
- 非文本块的高度:代码块(shiki 异步高亮)、mermaid、KaTeX、Tool 卡片、`render_ui` 交互卡片、图片 —— 这些继续走 `measureElement` 实测。
- 用 `layoutWithLines` 做 canvas/SVG 自绘文本渲染 —— 与 markdown 渲染、文本选区、a11y 冲突,不做。

## 3. 方案总览:混合式高度估计

```
                    ┌────────────────────────────────────────┐
 Segment/文本 ────→ │ block-splitter(mdast 分块)             │
                    │  text 块 ──→ pretext 预测高度 ─┐        │
                    │  非 text 块 ─→ 常数/历史实测缓存 ─┤ 合成  │
                    └────────────────────────────────┼───────┘
                                                     ↓
                     estimateItemSize(item) → VirtualList.estimateSize
                                                     ↓
                     measureElement 仍为**唯一权威**(残差自愈)
```

原则:**pretext 只负责"猜得更准",`measureElement` 仍是唯一权威**。任何 ±1px 级漂移都会在行被实测后自愈;pretext 的价值是让"从未实测过的行"的猜测从 120px 变成接近真值,并让流式尾行在首帧就有正确高度。

备选方案对比(为何选 pretext):

- **维持现状**:P1/P2 继续存在。
- **按 key 缓存上次实测高度**:只改善"重访"场景,首次打开/首次滚动到某行仍无解,流式无收益。
- **pretext**:能对**从未见过的内容**同步预测高度 —— 这是前两者做不到的。

## 4. 详细设计

### 4.1 新模块 `apps/desktop/src/renderer/src/lib/text-metrics/`

```
text-metrics/
  pretext-service.ts    # 单例:字体探测、prepare LRU、layout
  block-splitter.ts     # markdown → [{kind:'text'|'opaque', ...}]
  height-model.ts       # Segment → 预测高度(合成 text + opaque + 常数)
  index.ts
```

`pretext-service.ts`:

- 启动时(首次使用前)`await document.fonts.ready`,然后对 `.user-content` 探针元素 `getComputedStyle`,取出 `font-family / font-size / font-weight / line-height / letter-spacing`,拼成 canvas font shorthand 作为 `fontKey`。字号/字重不同的块(如标题)各自有 fontKey。
- `prepare` 结果按 `hash(text) + fontKey` 进 **LRU**(建议上限按总字符数预算,如 2M 字符;会话切换不清理,跨会话命中)。`layout` 足够廉价,不缓存结果。
- 暴露 `clearAllCaches()`,在以下时机调用:用户改字号/主题字体、`document.fonts` 加载事件、Electron zoom 级别变化。
- 可注入 canvas 测量后端(便于单测 mock 与未来 worker 化)。

`block-splitter.ts`:

- 输入 markdown 源文本,复用 Streamdown 已有的 remark 管线拿到 **mdast 块级 AST**(不二次实现 markdown 解析),把顶层块分类:
  - `text` 可测块:`paragraph`、`heading`(用对应字号/字重的 fontKey)、`blockquote`(内容按减去的缩进宽度测)、`list`(listItem 按减去 marker 缩进的宽度测,marker 高度取常数)。
  - `opaque` 不可测块:`code`、`math`、`mermaid`、`table`、`html`、`render_ui` 卡片。
- 流式增量关键设计:**稳定前缀 + 活跃尾块**。按块边界切开后,前 n-1 个完整块的文本不变 → prepared 句柄跨 delta 命中 LRU;只有最后一个未闭合块(通常是正在生长的段落)每个 delta 重新 `prepare`。避免整条消息重算。
- markdown 结构漂移(如段落中途出现 ```)会导致块重切,按全量 re-split 处理,正确性优先。

`height-model.ts`(合成规则,v1 从简):

```
estimate(item) =
  Σ text块:  max(1, lineCount) * lineHeight + 块间距常数
  Σ opaque块: opaqueHeightCache.get(hash(块内容 + 宽度桶 + 折叠态))
              ?? 该类型常数估计(如 code ≈ 行数*行高 + chrome)
  + 消息级 chrome(头像区、pb-5、工具条等常数)
```

- `opaqueHeightCache` 是"**实测记忆**":`measureElement` 拿到真值后,按内容 hash 回填,同内容块再次出现(重开历史会话、重复代码块)时估计即精确。会话级 Map 即可,不落盘。
- 折叠态(ReasoningBlock/Tool 卡片收起/展开)作为 cache key 的一部分,收起态是纯常数。

### 4.2 `VirtualList` 集成(最小侵入)

`virtual-list.tsx` 增加一个可选 prop:

```tsx
type VirtualListProps<T> = {
  // ...现有 props
  /** Per-item predicted size; falls back to `estimateSize` when undefined. */
  estimateItemSize?: (item: T, index: number) => number | undefined
}
```

```tsx
const virtualizer = useVirtualizer({
  // ...
  estimateSize: (index) => estimateItemSize?.(items[index], index) ?? estimateSize,
})
```

- TanStack Virtual 对**已实测**的行用实测值、仅对未实测行调 `estimateSize(index)` —— 语义完全匹配"预测未测量行"。
- `ConversationThread` 里为 `user/assistant/reasoning` 类型的 `TimelineItem` 提供 `estimateItemSize`(调 `height-model`);tool/event/divider/footer 返回 `undefined` 走原常数。
- `useStickToBottom` **一行不改**:它订阅的 `totalSize` 本来就来自 virtualizer,估计变准只会让它触发得更及时。
- `measureElement` **保留**:它继续纠正 pretext 漂移与非文本块的迟到尺寸(shiki 高亮、图片加载)。

### 4.3 流式尾行的首帧正确(v2 可选增强)

现状 P2 的时序:DOM 长高 → paint → ResizeObserver 回调 → virtualizer 更新 → layout effect 钉底,中间有一帧 `totalSize` 落后。

增强:在行组件的 `useLayoutEffect`(commit 后、paint 前)里,对比预测高度与 virtualizer 当前缓存尺寸,不一致则**同步**调 `virtualizer.measureElement(rowEl)` 强制实测,把"晚一帧"压成"零帧":

```tsx
useLayoutEffect(() => {
  if (predicted !== virtualizer.getSize(index)) virtualizer.measureElement(rowEl)
}, [predicted])
```

仅对流式尾行(状态可从 `segments` 推导)启用,避免常态多余 DOM 读取。此步依赖 4.1 的预测已足够准(否则会引入多余同步实测)。

### 4.4 宽度与失效管理

- 文本宽度 = `min(48rem, 容器宽) - 2rem(px-4)`;对 scroller 挂 ResizeObserver,宽度按 **4px 桶**取整作为 cache key 的一部分,桶内微小变化忽略(行高取整天然容忍)。
- `prepare` 句柄与宽度无关,**resize/zoom 只重跑 `layout`**(廉价);失效只需清 width 桶与 `opaqueHeightCache`,LRU 里的 prepared 可保留。

## 5. 关键风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| **字体不匹配**(macOS `system-ui` 不安全;Tailwind v4 默认栈以 `ui-sans-serif, system-ui` 开头) | 预测系统性偏差,退化成"更贵的常数估计" | 见决策点 D2。先在 Phase 0 spike 实测漂移;混合架构保证漂移只影响估计、实测自愈 |
| 中文/CJK 断行差异(`word-break` 与 CSS 不一致、html `lang` 影响浏览器字体回退) | 中文段落预测偏差 | CSS 与 pretext options 必须同步 `word-break: normal`;spike 语料**必须以中文为主**(本项目主要用户语料),含 emoji+标点、ZWSP 等已知边界用例 |
| 流式中 markdown 结构漂移(段落变代码块) | 预测短暂失准 | 全量 re-split;失准窗口 ≤1 帧,由实测自愈 |
| 超长单段文本(粘贴 10 万字符) | `prepare` O(n) 卡顿 | 文本超阈值(如 20k 字符)直接返回常数估计,`requestIdleCallback` 后台补 prepare 再更新 |
| 内存(prepared 句柄) | 长会话累积 | LRU 总字符预算;`clearAllCaches()` 挂钩失效时机 |
| jsdom 单测无 Canvas 2D | 无法直接测 pretext | service 依赖注入测量后端;单测 mock 度量,**准确性验证放真实 Chromium**(Phase 0 harness / Electron 冒烟) |
| Retina/DPR、zoom | 度量口径 | spike 在 1x/2x DPR 与 90%/110% zoom 下各跑一遍 harness 验证 |

## 6. 分阶段实施与验收

每阶段可独立合入、可回滚。

**Phase 0 — 准确性 spike(0.5–1 天,决定 D2)— ✅ 已完成(2026-09-16)**
结果见 `docs/research/2026-09-16-pretext-accuracy-spike.md`,harness 在 `scripts/spike-pretext/`。要点:真实语料(60 条仓库中文技术文档段落 + 8 条合成边界)× 5 种字体策略 × 3 档宽度,**现用 `-apple-system` 栈在 736px/500px 下 maxDrift = 0、100% ≤ 1px**(DPR 2);320px 极窄下 98.5% ≤ 1px(1 条一行级离群);`prepare` p50 ≈ 0.1ms、`layout` ≈ 0.002ms。验收通过,D2 拍板为策略 B。

**Phase 1 — text-metrics 模块(1–2 天)**
`pretext-service` + `block-splitter` + `height-model` + 单测(splitter 纯函数全覆盖;estimator 用 mock 度量测合成逻辑与 LRU)。
验收:模块在真实数据上输出稳定;vitest 通过;新增日志(遵循 CLAUDE.md §5):`info` 记录 service 初始化(fontKey、宽度桶)、`warn` 记录超长文本降级、`debug` 记录缓存命中率。

**Phase 2 — VirtualList 接入(0.5–1 天)**
新增 `estimateItemSize` prop,`ConversationThread` 接线。
验收:① 5k 行 fixture 会话,从顶部滚动到底再回滚,滚动条 thumb 位移抖动较 baseline 下降(录制对比,阈值:单次实测回填引起的跳动 < 8px);② 既有 `useStickToBottom` / `task-transcript` 测试全绿;③ 滚动性能 trace 中 `measureElement` 引起的强制回流次数不高于 baseline(估计层零 DOM 读取)。

**Phase 3 — 流式首帧正确(1 天)**
4.3 的尾行推送路径 + 稳定前缀/活跃尾块增量。
验收:流式 fixture 下,`totalSize` 与尾行实际 DOM 高度的同帧性(paint 前一致);Performance 录制中流式期间无可归因于测量的 long task(>16ms);钉底无可见跳动(录屏对比)。

**Phase 4 — 可选增强(1–2 天,按需)**
实测记忆缓存持久化到 sessionStorage、决策点 D2 若选策略 A 的具名字体落地、利用 `lineCount` 做"长消息折叠/展开"等特性。

## 7. 决策点(需要拍板)

- **D1 范围**:只做 `ConversationThread`(推荐;`TaskTimeline` 非虚拟化、quick-panel 无虚拟化,均无收益)。
- **D2 字体策略(已拍板 2026-09-16,依据 Phase 0 spike 实测)**:
  - **B. 维持现有 `-apple-system` 栈**(采纳):零视觉改动;真实聊天宽度下逐段 0 漂移,"macOS system-ui 不安全"告警在本环境未成立;实测兜底覆盖 320px 级窄宽度的罕见离群。
  - A. 消息区钉具名字体(SF Pro Text 已验证全宽度 100% 精确):保留为窄宽度离群高频化时的后备选项,当前不实施。
- **D3 v2 是否做**:先上 Phase 0–2(纯估计,零风险),观察 P1/P2 改善程度再决定。

## 8. 工作量汇总

核心路径(Phase 0–2):约 **2–4 人日**;含 Phase 3 约 **3–5 人日**。新增运行时依赖:`@chenglou/pretext`(MIT,零传递依赖,仅 renderer 使用)。
