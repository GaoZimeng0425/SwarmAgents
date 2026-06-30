# Stick-to-Bottom 虚拟消息列表原语

- 日期: 2026-06-30
- 分支: `worktree-stick-to-bottom-list`
- 状态: 设计待评审

## 1. 背景与目标

项目里已存在两套相关的基础设施,但二者从未合体:

- **`VirtualList`**(`src/renderer/src/components/ui/virtual-list.tsx`):通用纵向虚拟列表,基于
  `@tanstack/react-virtual` + 项目规范 `ScrollArea`。用 `measureElement` 运行时测高,行高可异构;
  `estimateSize` 仅用于首屏粗估。给 GitHub trending、Bilibili 收藏等**有界列表**用。**无任何吸底行为。**
- **`Conversation`**(`src/renderer/src/components/ai-elements/conversation.tsx`):直接套 `use-stick-to-bottom`
  库的 `StickToBottom`/`StickToBottom.Content`,暴露 `isAtBottom` / `scrollToBottom`,并提供独立的
  `ConversationScrollButton`(读 `useStickToBottomContext`)。**不虚拟化**,全量渲染消息。

agent transcript(`TaskTimeline`,`src/renderer/src/components/task-transcript.tsx`)产出的是一串**预渲染好的
React node**——消息、可折叠的 Thinking / Tool / Subagent 块、日期分隔等,高度全是动态的(流式文本增长、折叠展开、
图片经 IPC 异步加载后重测)。一旦对话变长,全量渲染的 DOM 与内存会失控。

**目标**:交付一个通用 `<StickToBottomList>` 原语,把 `VirtualList` 的虚拟化与 `Conversation` 的吸底语义合为一体——
既只渲染视口附近的行,又具备"新内容到达时若用户在底部则自动钉底、上滚则不打扰、并提供回到底部入口"的聊天体验。
它沿用 `VirtualList` 的 `items / getKey / renderItem` 数据 API,任何调用方(包括日后的 transcript)都能即插即用。

## 2. 关键决策(已与用户确认)

| 维度 | 决策 | 理由 |
|------|------|------|
| 范围 | 通用原语 `<StickToBottomList>`,非 transcript 专用 | 边界清晰、可独立测试、可复用;transcript 以后作为消费者接入(不在本次范围) |
| 吸底逻辑来源 | **手写** `useStickToBottom` hook,不依赖 `use-stick-to-bottom` 库 | 用户明确"模仿 use-stick-to-bottom 实现我自己的";且库自带原生滚动条 scroller,违反项目"所有滚动容器都用 `ScrollArea`、禁用原生滚动条"硬约定;库的 content 包裹层与 react-virtual 的 spacer 高度模型会冲突 |
| API 表面 | 列表组件 + context 暴露 `isAtBottom` / `scrollToBottom`;**不内置按钮** | 贴现有 `Conversation` / `ConversationScrollButton` 的拆分模式;原语保持 UI 无关,按钮由消费者自绘 |
| 与 `VirtualList` 共处 | 抽共享 `useVirtualList` + `<VirtualRows>`,`VirtualList` 改为薄壳调用它们 | 零重复、单一事实源;`VirtualList` 行为等价(被 trending/bilibili 复用),重构风险低 |

依赖确认:`@tanstack/react-virtual@^3.14.3`、`@base-ui/react`(ScrollArea 底层)均已安装。**不新增任何依赖。**

## 3. 范围与非目标

**范围内**:

- 新组件 `StickToBottomList` + context hook `useStickToBottomList`。
- 重构 `virtual-list.tsx`:抽出共享 `useVirtualList` / `<VirtualRows>`,`VirtualList` 改用之(行为等价)。
- 单元测试覆盖吸底 hook 的状态机;手动 playtest 验证真实滚动。

**非目标(YAGNI)**:

- 不改动 `TaskTimeline` / `Conversation` / 任何现有调用方。transcript 接入是后续独立工作。
- 不内置"回到底部"按钮组件(消费者自绘)。
- **不补偿"视口上方行变高"**(见 §7 限制)。
- 不做分页 / 窗口化历史加载(数据由调用方提供,原语只负责渲染+吸底)。

## 4. 架构

### 4.1 `virtual-list.tsx`(重构,行为等价)

把当前埋在 `VirtualList` 函数体里的两段抽成可复用件:

**`useVirtualList(opts)` → `{ viewportRef, virtualizer }`**

即当前 `virtual-list.tsx:41-50` 那段:建 `viewportRef`,`useVirtualizer` 的 `getScrollElement` 指向它,
`getItemKey` 走 `opts.getKey`,`estimateSize` / `overscan` / `gap` 透传。`measureElement` 仍由 `<VirtualRows>` 接到每行。

**`<VirtualRows virtualizer items renderItem />`**

即当前 `virtual-list.tsx:56-72` 那段:外层 `<div style={{ height: virtualizer.getTotalSize() }}>` 的 spacer,
内部把 `virtualizer.getVirtualItems()` 映射为 `absolute top-0 left-0 w-full` + `translateY(start)` +
`ref={virtualizer.measureElement}` 的行,调 `renderItem(items[i], i)`。

**`VirtualList`** 改为薄壳:

```tsx
export function VirtualList<T>({ items, getKey, renderItem, estimateSize, overscan, gap, className, edgeFade }: VirtualListProps<T>) {
  const { viewportRef, virtualizer } = useVirtualList({ items, getKey, estimateSize, overscan, gap })
  return (
    <ScrollArea className={className} edgeFade={edgeFade} viewportRef={viewportRef}>
      <VirtualRows virtualizer={virtualizer} items={items} renderItem={renderItem} />
    </ScrollArea>
  )
}
```

`VirtualListProps` 的对外签名**完全不变**——trending-view / bilibili-view 无需改动。

### 4.2 `stick-to-bottom-list.tsx`(新建)

复用 §4.1 的两样,叠加吸底 hook + context。

## 5. 组件 API

```tsx
// ---- 消费者侧 context ----
type StickToBottomListContextValue = {
  isAtBottom: boolean
  scrollToBottom: (behavior?: ScrollBehavior) => void  // behavior 默认 'smooth'
}

export function useStickToBottomList(): StickToBottomListContextValue {
  const ctx = useContext(StickToBottomListContext)
  if (!ctx) throw new Error("useStickToBottomList must be used within <StickToBottomList>")
  return ctx
}

// ---- 列表组件 ----
type StickToBottomListProps<T> = {
  items: readonly T[]
  getKey: (item: T, index: number) => string | number   // 稳定身份,保测高缓存正确
  renderItem: (item: T, index: number) => React.ReactNode
  estimateSize?: number        // 首屏粗估行高(px),默认 80(同 VirtualList)
  overscan?: number            // 视口外预渲染行数,默认 6
  gap?: number                 // 行间竖直间距(px),默认 0
  className?: string           // 包裹层,拥有滚动高度(如 "min-h-0 flex-1")
  edgeFade?: boolean           // ScrollArea 上下边缘渐隐,默认 false
  bottomTolerance?: number     // "算到底部"的 px 容差,默认 4(吸收亚像素/滚动条误差)
  children?: React.ReactNode   // 消费者覆盖层(如回到底部按钮)
}
```

渲染结构:

```tsx
export function StickToBottomList<T>({ items, getKey, renderItem, estimateSize, overscan, gap,
  className, edgeFade, bottomTolerance, children }: StickToBottomListProps<T>) {
  const { viewportRef, virtualizer } = useVirtualList({ items, getKey, estimateSize, overscan, gap })
  const totalSize = virtualizer.getTotalSize()
  const { isAtBottom, scrollToBottom } = useStickToBottom(viewportRef, totalSize, bottomTolerance)

  const ctx = useMemo(
    () => ({ isAtBottom, scrollToBottom }),
    [isAtBottom, scrollToBottom],
  )

  return (
    <StickToBottomListContext.Provider value={ctx}>
      <div className={cn("relative", className)}>
        <ScrollArea className="size-full" edgeFade={edgeFade} viewportRef={viewportRef}>
          <VirtualRows virtualizer={virtualizer} items={items} renderItem={renderItem} />
        </ScrollArea>
        {children}
      </div>
    </StickToBottomListContext.Provider>
  )
}
```

`relative` 包裹层使消费者的按钮能 `absolute` 贴底;`className` 仍拥有高度(从 `VirtualList` 里 ScrollArea 根挪到
包裹层,语义等价)。消费者典型用法:

```tsx
<StickToBottomList items={segs} getKey={(s) => s.key} renderItem={renderRow} className="min-h-0 flex-1">
  <ScrollToLatestButton />   {/* 内部读 useStickToBottomList(),!isAtBottom 时显示 */}
</StickToBottomList>
```

## 6. 吸底机制(`useStickToBottom`,组件内 ~30 行)

```tsx
function useStickToBottom(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  totalSize: number,          // virtualizer.getTotalSize(),测高变化时变
  tolerance = 4,
) {
  const [isAtBottom, setIsAtBottom] = useState(true)
  const stuckRef = useRef(true)            // 真正的"是否吸底":一旦用户上滚即 false

  // 1) scroll 监听:重算 isAtBottom;到底则重新吸住
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= tolerance
      stuckRef.current = atBottom
      setIsAtBottom(atBottom)
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [viewportRef, tolerance])

  // 2) 内容增高时,若仍吸住则钉底。useLayoutEffect → paint 前同步,无闪烁
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el || !stuckRef.current) return
    el.scrollTop = el.scrollHeight
  }, [viewportRef, totalSize])

  // 3) 主动回到底部(按钮调用)
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = viewportRef.current
    if (!el) return
    stuckRef.current = true
    setIsAtBottom(true)
    el.scrollTo({ top: el.scrollHeight, behavior })
  }, [viewportRef])

  return { isAtBottom, scrollToBottom }
}
```

**为什么 `useLayoutEffect` 依赖 `totalSize` 就够:** `measureElement` 在行挂载 / 内容变化时回调,virtualizer
内部状态变更会触发本组件重渲,`getTotalSize()` 在渲染体内取到最新值,layout effect 随之重跑。新消息追加、流式
尾行增长、图片 IPC 加载后重测——全部经此路径覆盖。`useLayoutEffect`(非 `useEffect`)保证 `scrollTop` 赋值在
浏览器 paint 前完成,流式时无可见跳动。

**`stuckRef` vs `isAtBottom`:** `isAtBottom` 是给 UI 的状态(驱动按钮显隐);`stuckRef` 是吸底判定的真值,避免
`setState` 异步导致的"这一帧还没翻过来就漏钉"。两者在 scroll 监听里同步更新。

**初始状态:** `stuckRef` 初值 `true`,首屏 mount 时 layout effect 即把视口钉到底——新对话自动停在底部。

## 7. 边界与已知限制

- ✅ **动态测高 / 流式增长 / 图片延迟加载**:`measureElement` → `totalSize` 变 → layout effect 重钉,全链路覆盖。
- ✅ **上滚不打扰**:用户上滚 → `stuck=false`;之后内容继续增长也不会把视口拽下去;按钮显示;点按钮或手动滚回底部 → 重新吸住。
- ✅ **亚像素 / 滚动条**:`bottomTolerance`(默认 4px)吸收,避免"明明在底部却判定不在"。
- ⚠️ **视口上方行变高不补偿**:用户滚到中段时,若比可见区更早的行变高(如折叠块展开),可见内容会被顶上去。聊天是尾部追加,
  几乎不触发;按 YAGNI 不做。如未来需要,再引入 react-virtual 的 `ScrollOffset` / 锚点 delta 机制,届时单独评审。
- ⚠️ **`getKey` 必须稳定**:与 `VirtualList` 同要求,调用方负责。key 不稳会破坏测高缓存,导致跳动——非本原语职责。
- ⚠️ **平滑滚动期间的中途 scroll 事件**:`scrollToBottom('smooth')` 与钉底赋值 `scrollTop` 都会触发 scroll 事件,
  动画中途 `atBottom` 可能为 false,若直接据此更新 `stuckRef` 会误翻为 false,导致动画期间 `totalSize` 变化时漏钉。
  实现期引入一个 `programmaticScrollRef` 标志:在 `scrollToBottom` / 钉底赋值前置 true、动画结束(`scrollend` 或
  rAF 探测到底)后置 false;`onScroll` 里若该标志为真则跳过 `stuckRef` 更新。`scrollTop = scrollHeight` 的即时
  钉底(非动画)同样置位,避免那一帧的 scroll 回调干扰。

## 8. 测试策略

jsdom 不做真实布局(`scrollHeight` / `clientHeight` 为 0,`scrollTop` 赋值无效果),**无法单测真实滚动几何**。
因此分两层:

**单元测试**(`src/renderer/src/components/ui/stick-to-bottom-list.test.tsx`,vitest,经 `npm test` 在 Electron node 下跑):

mock viewport 元素的 `scrollHeight` / `clientHeight` / `scrollTop`(用 `Object.defineProperty` 注入 getter/setter,
setter 记录赋值),断言 hook 状态机:

1. 初态 `isAtBottom === true`。
2. 模拟用户上滚(`scrollTop` 设为远离底部)→ 触发 scroll 事件 → `isAtBottom === false`;此后让 `totalSize` 变化,
   断言 `scrollTop` **未**被赋为 `scrollHeight`(不抢用户)。
3. 调 `scrollToBottom()` → `isAtBottom === true` 且 `scrollTop` 被设到 `scrollHeight`。
4. 在吸底态让 `totalSize` 增长 → 断言 `scrollTop` 被钉到新的 `scrollHeight`。

**回归:** `VirtualList` 重构后,确认 trending-view / bilibili-view 渲染路径无变化(目前二者无单测覆盖,靠类型检查 +
手动验证;若改动后发现已有相关快照测试则一并跑)。

**手动 playtest(真验证):** 用 `run-desktop` 在 app 内挂一个临时消费者,喂入可增长的长列表(模拟流式追加):

- 首屏自动在底部;新行追加时视口保持钉底、无跳动。
- 上滚 → 停止吸底、"回到底部"按钮出现。
- 点按钮 → 平滑回到底部并重新吸住。
- 图片异步加载、折叠块展开后高度变化 → 不破坏吸底 / 不错位。

playtest 结论须以截图 / DevTools 观察为准,不靠"应该没问题"。

## 9. 实现步骤概要(供后续 writing-plans 细化)

1. 重构 `virtual-list.tsx`:抽 `useVirtualList` + `<VirtualRows>`,`VirtualList` 改薄壳。 → 验证:类型通过,trending/bilibili 视图手测无变化。
2. 新建 `stick-to-bottom-list.tsx`:`StickToBottomList` + `StickToBottomListContext` + `useStickToBottomList` + `useStickToBottom`。 → 验证:类型通过。
3. 写 `stick-to-bottom-list.test.tsx`,跑 `npm test` 全绿。 → 验证:4 条状态机断言通过。
4. 临时消费者 playtest(挂在某个 dev-only 入口或现有视图)。 → 验证:§8 playtest 清单逐条过。
5. 移除临时消费者(若是 dev-only 入口),保留组件与测试。提交。

## 10. 开放问题

无。命名(`useVirtualList` / `VirtualRows` / `StickToBottomList`)为实现期可微调,不改变设计。
