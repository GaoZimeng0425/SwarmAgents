# 把 shadcn MessageScroller 的滚动语义移植进 VirtualList — 技术方案

Date: 2026-09-16
Status: draft
Scope: `apps/desktop` renderer,`VirtualList` + `ConversationThread`
前置阅读: `2026-09-10-pretext-message-list-height-estimator-design.md`(pretext 高度估计,与本方案叠加而非竞争)

## 1. 背景一:现状方案(VirtualList)是什么、怎么实现的

### 1.1 数据链路

```
AgentWireEvent(IPC 'swarm:event')
  → applyWireEvent(hook: use-events-subscription) 折叠进 SessionView(TanStack Query cache)
  → useSessionView → buildSegments(view) 产出 Segment[](含流式尾段 key='streaming')
  → buildThreadItems(segments, renderSegment) 产出 TimelineItem[]
      TimelineItem = { key: string, node: ReactNode, order: number, ts: number }
      key 来源:seg.key(稳定,entry 键 / 'streaming')、`day-${day}`(日分隔)、'__footer'(spinner)
  → <VirtualList items getKey renderItem> 窗口化渲染
```

live 会话的数据**严格尾部追加**;`hydrate()`(补历史)发生在挂载时一次性整表替换,不是增量前插。

### 1.2 渲染机制(apps/desktop/.../viewers/virtual-list.tsx)

- `useVirtualizer({ count, estimateSize: () => 120, overscan: 8, onChange })`:只渲染可见 + overscan 的行,行绝对定位在 `height: totalSize` 的 spacer 里,`translateY(start)`。
- 每行 `ref={virtualizer.measureElement}`:ResizeObserver 实测行高,实测值覆盖 120 的估计值;`onChange` 把 `getTotalSize()` 同步进 React state,驱动重渲与钉底。
- 未测量行的高度全靠 120px 常数猜测 —— 这是 pretext 方案要解决的问题(估计层),与本方案(行为层)正交。

### 1.3 钉底机制(useStickToBottom,~100 行手写状态机)

- `stuckRef`(真值)/ `isAtBottom`(UI 态)分离;scroll 监听里几何判定 `scrollHeight - scrollTop - clientHeight ≤ 4px`。
- 两个误判抑制器:程序平滑滚动期间(`smoothScrollingRef`,scrollend + 500ms 兜底复位)、拖拽选区期间(`isSelecting()`)。
- `useLayoutEffect` 订阅 `totalSize`:内容长高且仍 stuck → paint 前 `scrollTop = scrollHeight` 重钉。
- Context 暴露 `{ isAtBottom, scrollToBottom }`,消费者画 `ScrollToLatest` 按钮。

### 1.4 现有功能清单与缺口

| 已有 | 缺失(MessageScroller 有而我们没有) |
|------|------|
| 窗口化渲染、动态测高 | scrollToMessage(跳转指定消息,多对齐方式) |
| 钉底 / 上滚暂停 / 回底按钮 | turn 锚定(新回合对齐消息顶部 + peek、流式跟随该消息) |
| edge fade、scroller 所有权隔离(见文件头注释) | 可见性订阅(哪些消息在视口、当前锚点) |
| — | prepend 防跳、a11y(region/log/键盘)、spacer 补位 |

## 2. 背景二:MessageScroller 的方案与实现(@shadcn/react@0.2.1,读源码结论)

**路线:全量挂载 + 浏览器原生高度 + DOM 变化驱动的滚动状态机。不做虚拟化、不做高度估计**;渲染性能外包给消费者在 Item 上加的 `content-visibility: auto`(本仓库 packages/ui 封装已加,desktop 未使用)。

组件:`Provider(状态机)/ Root / Viewport / Content / Item / Button`,四模式:`following-bottom`、`anchored-to-message`、`settling-jump`、`free-scrolling`。核心实现:

1. **跟随底部**:Content 上 MutationObserver(childList,消息增删)+ ResizeObserver(内容长高)→ `following-bottom` 时 `scrollToEnd()`。程序滚动打 `data-autoscrolling`(180ms),配合 CSS 隐藏滚动条防闪。
2. **用户接管**:**输入事件判定**——wheel/touchmove/导航键一律切 `free-scrolling`(对比:我们用几何判定 + suppressor)。
3. **turn 锚定**:Item 标 `data-scroll-anchor`(每回合首条)。流式中出现新 anchor:单个 → `scrollToMessage(anchor, align:'start', peek 64px)`(上一条消息露出 64px);多个(批量)→ 直接到底。之后该消息流式变长,`anchored-to-message` 模式在 resize 时**反复重锚到它的顶部**——视口跟着这条消息"读"。
4. **scrollToMessage**:getBoundingClientRect 算术,支持 start/center/end/nearest,折算 scroll-margin、content padding、行间 gap。
5. **spacer 补位**:跳到靠前的老消息 align start 时,其下方内容不够填满视口、无法滚到目标位置 → Content 末尾一个隐藏 spacer div 撑出虚拟滚动空间,回到底/顶时清零。
6. **prepend 防跳**:记录第一可见元素及其 viewportTop,前插后 `scrollTop += delta`。
7. **可见性**:IntersectionObserver(root=viewport)维护 `visibleMessageIds` + `currentAnchorId`,rAF 合并 + shallow compare 的 external store,`useSyncExternalStore` 暴露。
8. **a11y**:Viewport `role="region"` + 键盘滚动;Content `role="log" aria-relevant="additions"`(流式 live region)。

## 3. 功能对照:两边分别怎么实现的、移植结论

| 功能 | MessageScroller 实现 | VirtualList 现状 | 移植结论 |
|------|---------------------|------------------|----------|
| 跟随底部 | MutationObserver+RO → scrollToEnd | totalSize 驱动 useLayoutEffect | 已有,不改 |
| 上滚暂停 | 输入事件切 free | 几何判定 + suppressor | 已有,不改(差异见 §6-D2) |
| 回底按钮 | Button + external store active | ScrollToLatest + context | 已有,不改 |
| scrollToMessage | 全量 DOM rect 算术 | ❌ | **移植**:key→index→`scrollToIndex`(§4.1) |
| 跳转落定/流式重锚 | settling-jump + reanchor | ❌ | **移植**:settle 校正(§4.2) |
| turn 锚定 + peek | anchor 标记 + 模式切换 | ❌ | **移植**:followMode 状态机(§4.3) |
| 可见性订阅 | IO + external store | ❌ | **移植**(§4.4) |
| prepend 防跳 | 首元素快照 + scrollTop 修正 | ❌(场景也不存在,append-only) | **不移植**,设计备查(§4.5) |
| spacer 补位 | 隐藏 spacer 撑虚拟空间 | 天然不需要:totalSize spacer 已覆盖全部虚拟高度 | **不移植**(§4.6) |
| a11y | region/log/键盘 | ❌ | **移植**,纯标注(§4.7) |
| data-autoscrolling | 程序滚动隐藏滚动条 | ❌ | 可选移植(P2) |

## 4. 各功能移植设计

**总原则:语义移植,不是代码搬运。** MessageScroller 的一切 rect 算术,在窗口化下换成"高度表算术";一切 DOM 变化监听,换成 `totalSize`/测量变化驱动。窗口化的代价是:跳转目标行可能未挂载、其高度是估计值——所以每个"定位"类功能都必须带落定校正。

### 4.1 `scrollToItem(key, opts)`(对应 scrollToMessage)

VirtualList 已有 `items`/`getKey`,内部补一个 `keyToIndex` Map;context 新增:

```tsx
type ScrollToItemOptions = {
  align?: 'start' | 'center' | 'end' | 'nearest'  // default 'start'
  behavior?: ScrollBehavior                        // default 'auto'
  peek?: number                                    // align='start' 时目标上方预留 px
}
scrollToItem: (key: string, opts?: ScrollToItemOptions) => boolean
```

实现:`index = keyToIndex.get(key)`;`offset = virtualizer.getOffsetForIndex(index, align)`;`peek > 0` 时 `offset -= peek` 再 clamp ≥ 0;`virtualizer.scrollToOffset(offset, { behavior })`。未挂载目标行的 offset 来自高度表(已测行 = 实测,未测行 = 估计)→ **落点精度取决于估计质量,这正是 pretext 方案的价值**(§6-D3 排序依据)。找不到 key 返回 false(对齐 MessageScroller 的 pending 语义:可先记 pending,items 到达后 flush——初版不做,调用方等数据就绪再调)。

### 4.2 落定校正(settle correction,对应 settling-jump/reanchor)

跳转后把 `{ key, align, peek, tries, deadline(~300ms) }` 存 ref;VirtualList 的 `onChange`(totalSize 因后续测量而变)内,deadline 之前重算目标 offset,与当前实际落点差 > 0.5px 则重应用,最多 N(如 5)次,或达标/超时/用户滚动即撤销。`peek` 用 `getOffsetForIndex` 重算而非增量,幂等。

### 4.3 turn 锚定(followMode 状态机扩展)

`useStickToBottom` 的布尔 `stuck` 扩展为三态 `followMode: 'bottom' | 'item' | 'free'`。

**anchor 标注对象(已拍板 2026-09-16):用户消息**。`ConversationThread` 里 `getScrollAnchor` 对 `kind === 'user'` 的 segment 返回 true。UX 效果:发送消息后视口对齐到这条用户消息的顶部(上一条回复的尾部 peek 64px),助手回复与工具调用在其下方流式生长——ChatGPT 式"我的问题钉在上面,回答往下流"的阅读体验。

- **进入 item**:`items` 中出现**单个**新 anchor(新 user 段)→ `scrollToItem(newAnchor, { align:'start', peek: 64 })`,置 `mode='item'`、记录 anchorKey。无论当前是 `bottom` 还是 `free`(用户在翻历史时发送了新消息,同样应跳到自己的消息上)都触发。批量出现(打开会话/整表 hydrate,新增 anchor 数 > 1)→ 不锚定,走默认到底,对齐 MessageScroller 语义。
- **维持 item**:mode='item' 且 anchorKey 未变时,`totalSize` 变化(流式增长/测量回填)→ 重算并应用 `scrollToItem(anchorKey, start, peek)`(等价 reanchor;流式只发生在 anchor 下方,其上方内容不变,offset 稳定,无反馈风暴)。
- **退出 item**:wheel/touchmove/导航键(新增监听,轻量)或几何上滚判定 → `mode='free'`。用户向下翻看回复时自然退出锚定。
- **切换 item**:锚定期间又发送了下一条消息 → anchorKey 切到新 anchor(重走进入逻辑)。
- `scrollToBottom()`(回底按钮)→ `mode='bottom'`,现有语义不变。

VirtualList 接线:新增 prop `getScrollAnchor?: (item: T) => boolean`;默认关闭,feature flag 起步(§6-D1),产品验收后转默认开启。

### 4.4 可见性跟踪 `useVirtualListVisibility()`

VirtualList 内部对每个已挂载行元素(与 measureElement 同一 ref)挂一个 `IntersectionObserver`(root = scroller,rootMargin 按 peek/scrollMargin 内缩),维护 `visibleKeys: Set<string>` 与 `currentAnchorKey`(自上而下最后一个 anchor 且 top ≤ viewportTop + peek)。rAF 合并 + shallow compare 的 external store,`useSyncExternalStore` 暴露。可见行必然已挂载,所以 IO 方案**原样成立**,这是移植中差异最小的一块。

### 4.5 prepend 防跳(不移植,备查)

需要时:key+offset 快照(第一可见行的 key + 其相对视口顶偏移)→ 列表前插后按 key 找新 index → `scrollToOffset(newStart + offsetWithin)`。当前数据链路 append-only、hydrate 整表替换后直接到底,**无此场景**,按 YAGNI 不做;若未来做"加载更早历史"再启用。

### 4.6 spacer 补位(不移植)

MessageScroller 需要 spacer 是因为全量渲染下"老消息下方没有足够真实内容"来支撑 align start 的滚动位置。窗口化下 `totalSize` spacer 本来就等于全部行的虚拟总高,`scrollToOffset` 可以落在任何合法位置——**虚拟化天然包含这个能力**,直接删掉该机制。

### 4.7 a11y 与 data 标注(直接移植)

scroller div:`role="region"` `aria-label="Messages"` `tabIndex=0` + 键盘滚动(原生即可);content wrapper:`role="log"` `aria-relevant="additions"`;行元素:`data-message-id={key}`、anchor 行 `data-scroll-anchor`。纯属性标注,零行为风险。

## 5. 分阶段实施与验收

- **Phase A — 跳转语义(0.5–1 天)**:`scrollToItem` + settle 校正 + a11y/data 标注。
  验收:dev-only 测试入口对 2k 行 fixture 会话执行"跳到第 N 条"(N 含未挂载区域),落定后目标行 top 与视口顶偏差 ≤ 2px(校正收敛);现有 virtual-list 测试全绿。
- **Phase B — 可见性(0.5 天)**:IO + store + `useVirtualListVisibility`。
  验收:滚动时 visibleKeys 与实际视口一致(抽检),rAF 合并下无可感知 re-render 风暴(React Profiler)。
- **Phase C — turn 锚定(1 天)**:followMode 状态机 + `getScrollAnchor` + ConversationThread 接线(feature flag)。
  验收:发送消息后视口对齐该用户消息顶部、上一条回复尾部 peek 64px;回复/工具流式生长期间视口稳定在用户消息顶部;翻历史时发送新消息会跳到新消息;上滚/回底交互不回归(现有 useStickToBottom 状态机测试扩展三态后全绿);批量 hydrate 不锚定。
- **Phase D — 可选**:data-autoscrolling 滚动条隐藏;prepend(如有历史加载需求)。

## 6. 风险与决策点

- **锚定/校正的反馈循环**:重锚 → 触发测量 → totalSize 变 → 再重锚。防护:差值 ≤ 0.5px 不应用、tries/deadline 上限、仅 anchor 行测量变化时触发。
- **估计不准时跳转漂移**:estimateSize=120 下跳到深处误差可达数百 px,settle 校正会多次拉扯。**pretext 方案是本方案跳转精度的前置增强**(见 D3)。
- **D1(已拍板 2026-09-16)**:anchor 标在**用户消息**上;实现以 feature flag 起步,产品验收后转默认开启。
- **D2 用户接管模型**:保留现有几何判定(已处理平滑滚动/选区误判),仅为退出 anchored 补 wheel/touch/key 监听;MessageScroller 模型存在"拖滚动条不触发接管"的盲区,不整体换。
- **D3 与 pretext 的顺序**:建议 pretext Phase 2 先行/并行,跳转直接受益于准确高度表;两者代码无耦合,顺序不阻塞。

## 7. 工作量

核心路径(Phase A–C)约 **2–2.5 人日**。不新增依赖;全部改动收敛在 `virtual-list.tsx`(状态机与 context 扩展)+ `conversation-thread.tsx`(接线)+ 新增 `use-virtual-list-visibility.ts`。
