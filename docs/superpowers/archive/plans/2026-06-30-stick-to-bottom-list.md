# Stick-to-Bottom 虚拟消息列表原语 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付通用 `<StickToBottomList>` 原语——把现有 `VirtualList` 的 `@tanstack/react-virtual` 虚拟化与手写"自动吸底"行为合为一体,通过 context 暴露 `isAtBottom` / `scrollToBottom`。

**Architecture:** 重构 `virtual-list.tsx` 抽出共享的 `useVirtualList` hook + `<VirtualRows>` 组件(`VirtualList` 变薄壳,对外签名不变);新建 `stick-to-bottom-list.tsx` 复用二者,叠加 `useStickToBottom` hook(scroll 监听 + 依赖 `getTotalSize()` 的 `useLayoutEffect` 钉底 + `programmaticRef` 防平滑滚动中途误判)+ React context。

**Tech Stack:** TypeScript、React 19、`@tanstack/react-virtual@^3.14.3`、`@base-ui/react` ScrollArea、vitest(electron node 跑)、`@testing-library/react`、biome。

## Global Constraints

(本节为每个 task 隐式前置条件,值逐字取自 spec / 项目约定)

- **语言**:对话用中文;**代码注释与 commit message 一律英文**(CLAUDE.md §0)。
- **滚动容器**:所有滚动容器用 `ScrollArea`(`@/components/ui/scroll-area`),**禁用原生滚动条**(项目硬约定)。
- **测试命令**:`npm test`(等价 `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`)。**禁用** `pnpm rebuild better-sqlite3`(会破坏 app ABI)。单文件过滤:`npm test -- src/renderer/src/components/foo.test.tsx`。
- **类型检查**(renderer):`npm run typecheck:web`(`tsc --noEmit -p tsconfig.web.json`)。
- **Lint/format 限定范围**:`npx biome check --write <file>`(**不要**用 `pnpm check`/`npm run check`——它会重排整个仓库)。
- **不新增依赖**:`@tanstack/react-virtual`、`@base-ui/react` 均已安装。
- **别名**:`@` → `src/renderer/src`(见 `vitest.config.ts`)。
- **测试环境**:renderer 测试用 jsdom;`src/renderer/test-setup.ts` 已 stub `ResizeObserver`/`IntersectionObserver`/`getAnimations`,并把 `HTMLElement.prototype.offsetHeight` 默认改为 600(让 react-virtual 在 jsdom 渲染出行)。
- **当前工作区**:`worktree-stick-to-bottom-list` 分支;所有路径相对仓库根;commit 提交到该分支。

---

## File Structure

- **Modify** `src/renderer/src/components/ui/virtual-list.tsx` — 抽出 `useVirtualList` + `<VirtualRows>`(`VirtualList` 变薄壳,签名不变)。职责:react-virtual 装配与行定位的单一事实源。
- **Create** `src/renderer/src/components/ui/stick-to-bottom-list.tsx` — `StickToBottomList` 组件、`StickToBottomListContext`、`useStickToBottomList`、`useStickToBottom` hook。职责:虚拟化列表 + 吸底语义 + 状态暴露。
- **Create** `src/renderer/src/components/ui/virtual-list.test.tsx` — `VirtualList` characterization 测试(保护重构)。
- **Create** `src/renderer/src/components/ui/stick-to-bottom-list.test.tsx` — `useStickToBottom` 状态机测试 + `StickToBottomList` smoke 测试。
- **Create (throwaway)** `src/renderer/src/components/ui/stick-to-bottom-playground.tsx` — 仅 Task 4 手动 playtest 用,**不提交**。

---

## Task 1: 重构 `virtual-list.tsx` 抽出共享件

把当前 `VirtualList` 函数体里第 41–50 行(virtualizer 装配)和第 56–72 行(spacer + 定位行)抽成 `useVirtualList` hook 与 `<VirtualRows>` 组件,`VirtualList` 改为薄壳。**对外签名与行为完全不变。**

**Files:**
- Modify: `src/renderer/src/components/ui/virtual-list.tsx`
- Test: `src/renderer/src/components/ui/virtual-list.test.tsx`

**Interfaces:**
- Produces:
  - `VirtualizerInstance` = `Virtualizer<HTMLDivElement, HTMLDivElement>` 类型别名。
  - `useVirtualList<T>(opts: { items: readonly T[]; getKey: (item: T, index: number) => string | number; estimateSize?: number; overscan?: number; gap?: number }): { viewportRef: React.RefObject<HTMLDivElement | null>; virtualizer: VirtualizerInstance }`
  - `<VirtualRows<T>>({ virtualizer, items, renderItem }: { virtualizer: VirtualizerInstance; items: readonly T[]; renderItem: (item: T, index: number) => React.ReactNode })` — 渲染 spacer + 绝对定位测高行。
- Consumes: `ScrollArea` (`@/components/ui/scroll-area`,props `className`/`edgeFade`/`viewportRef`)、`useVirtualizer` + type `Virtualizer` (`@tanstack/react-virtual`)。

> **类型提示**:`useVirtualizer` 的元素泛型由 `getScrollElement`(`HTMLDivElement`)与 `measureElement` 接到的行元素(`HTMLDivElement`)推断。若 `npm run typecheck:web` 在 hook 返回标注处报 virtualizer 类型不符,把 `VirtualizerInstance` 的两个泛型参数对齐到 `useVirtualizer` 实际推断(可能为 `Element`),返回标注会精确定位差异。

- [ ] **Step 1: 写 characterization 测试(锁定现有行为)**

Create `src/renderer/src/components/ui/virtual-list.test.tsx`:

```tsx
// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { VirtualList } from './virtual-list'

afterEach(() => {
  cleanup()
})

describe('VirtualList', () => {
  it('renders the ScrollArea root and the items', () => {
    render(
      <VirtualList
        className="h-[600px]"
        getKey={(s) => s}
        items={['alpha', 'beta', 'gamma']}
        renderItem={(s) => <div>{s}</div>}
      />,
    )
    // ScrollArea root is present (project convention: all scroll uses ScrollArea).
    expect(document.querySelector('[data-slot="scroll-area"]')).not.toBeNull()
    // test-setup.ts mocks offsetHeight=600 so react-virtual renders the rows.
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
    expect(screen.getByText('gamma')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 跑测试,确认在**重构前**就通过(锁定基线)**

Run: `npm test -- src/renderer/src/components/ui/virtual-list.test.tsx`
Expected: PASS(1 test)。若 FAIL,先修到通过再重构(确认基线有效)。

- [ ] **Step 3: 重构 `virtual-list.tsx`**

Replace the entire file `src/renderer/src/components/ui/virtual-list.tsx` with:

```tsx
// Generic vertical virtualized list. Renders only the rows near the viewport so
// long lists (GitHub trending, sessions, Bilibili favorites) keep their DOM —
// and the memory their nodes/images hold — bounded regardless of item count.
//
// Built on the canonical ScrollArea (styled scrollbar is a project-wide
// convention) and `@tanstack/react-virtual`. Row heights are measured at
// runtime via `measureElement`, so callers don't need uniform-height rows;
// `estimateSize` only needs to be a rough average for the initial paint.
//
// `useVirtualList` + `<VirtualRows>` are shared with `StickToBottomList`, which
// composes the same virtualization and adds stick-to-bottom behavior.
import { useRef } from 'react'
import { type Virtualizer, useVirtualizer } from '@tanstack/react-virtual'

import { ScrollArea } from '@/components/ui/scroll-area'

// Concrete virtualizer type: the scroll element is a div (the ScrollArea
// viewport) and each rendered row is a div. Keep both uses aligned on this
// alias so the hook's return and the component's prop can't drift apart.
type VirtualizerInstance = Virtualizer<HTMLDivElement, HTMLDivElement>

type VirtualListOptions<T> = {
  items: readonly T[]
  /** Stable identity per item — keeps measurement cache correct across reorders/filters. */
  getKey: (item: T, index: number) => string | number
  /** Rough average row height (px) for the first paint, before real measurement. */
  estimateSize?: number
  /** Rows rendered beyond each viewport edge. */
  overscan?: number
  /** Vertical gap between rows (px). */
  gap?: number
}

// Owns the scroll viewport ref and configures the virtualizer. Both VirtualList
// and StickToBottomList call this so the react-virtual wiring lives in one place.
export function useVirtualList<T>(
  opts: VirtualListOptions<T>,
): { viewportRef: React.RefObject<HTMLDivElement | null>; virtualizer: VirtualizerInstance } {
  const viewportRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: opts.items.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => opts.estimateSize ?? 80,
    getItemKey: (index) => opts.getKey(opts.items[index] as T, index),
    overscan: opts.overscan ?? 6,
    gap: opts.gap ?? 0,
  })

  return { viewportRef, virtualizer: virtualizer as VirtualizerInstance }
}

// Spacer whose height = total virtualized size, with each measured row absolutely
// positioned via translateY. Presentational; takes a configured virtualizer.
export function VirtualRows<T>({
  virtualizer,
  items,
  renderItem,
}: {
  virtualizer: VirtualizerInstance
  items: readonly T[]
  renderItem: (item: T, index: number) => React.ReactNode
}): React.JSX.Element {
  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualItems.map((virtualRow) => {
        const item = items[virtualRow.index]
        if (item === undefined) return null
        return (
          <div
            className="absolute top-0 left-0 w-full"
            data-index={virtualRow.index}
            key={virtualRow.key}
            ref={virtualizer.measureElement}
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            {renderItem(item, virtualRow.index)}
          </div>
        )
      })}
    </div>
  )
}

type VirtualListProps<T> = VirtualListOptions<T> & {
  renderItem: (item: T, index: number) => React.ReactNode
  /** Class for the ScrollArea root — it owns the scroll height (e.g. "min-h-0 flex-1"). */
  className?: string
  /** Show top/bottom edge fades on the ScrollArea. */
  edgeFade?: boolean
}

export function VirtualList<T>({
  items,
  getKey,
  renderItem,
  estimateSize,
  overscan,
  gap,
  className,
  edgeFade = false,
}: VirtualListProps<T>): React.JSX.Element {
  const { viewportRef, virtualizer } = useVirtualList({ items, getKey, estimateSize, overscan, gap })

  return (
    <ScrollArea className={className} edgeFade={edgeFade} viewportRef={viewportRef}>
      <VirtualRows items={items} renderItem={renderItem} virtualizer={virtualizer} />
    </ScrollArea>
  )
}
```

> 若 `virtualizer as VirtualizerInstance` 的断言不必要(类型已匹配),去掉断言保留干净代码;若 typecheck 报错,按上面"类型提示"对齐 `VirtualizerInstance` 泛型,而不是用 `as any`。

- [ ] **Step 4: 跑 typecheck + 测试,确认行为不变**

Run: `npm run typecheck:web`
Expected: 无错误。

Run: `npm test -- src/renderer/src/components/ui/virtual-list.test.tsx`
Expected: PASS(1 test)。

- [ ] **Step 5: biome 限定范围格式化**

Run: `npx biome check --write src/renderer/src/components/ui/virtual-list.tsx src/renderer/src/components/ui/virtual-list.test.tsx`
Expected: 格式化通过(若改动了文件)。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/ui/virtual-list.tsx src/renderer/src/components/ui/virtual-list.test.tsx
git commit -m "refactor(virtual-list): extract useVirtualList + VirtualRows for reuse

No behavior change to VirtualList — the react-virtual wiring (viewport ref,
virtualizer config, spacer + measured rows) moves into shared useVirtualList
and <VirtualRows> so the upcoming StickToBottomList can compose them."
```

---

## Task 2: `useStickToBottom` hook(TDD)

实现吸底核心逻辑,先写状态机测试再实现。hook 导出以供测试。

**Files:**
- Create: `src/renderer/src/components/ui/stick-to-bottom-list.tsx`
- Test: `src/renderer/src/components/ui/stick-to-bottom-list.test.tsx`

**Interfaces:**
- Produces: `useStickToBottom(viewportRef: React.RefObject<HTMLDivElement | null>, totalSize: number, tolerance?: number): { isAtBottom: boolean; scrollToBottom: (behavior?: ScrollBehavior) => void }`
- Consumes: 无(纯 hook,直接读写 DOM scroll 属性)。

- [ ] **Step 1: 写失败测试(状态机)**

Create `src/renderer/src/components/ui/stick-to-bottom-list.test.tsx`:

```tsx
// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'

import { useStickToBottom } from './stick-to-bottom-list'

afterEach(() => {
  cleanup()
})

// Mount the hook against a real div so the ref + scroll listener attach. We mock
// scrollHeight/clientHeight/scrollTop on the instance (jsdom does no layout, so
// these are 0 and scrollTop assignment is a no-op without our override).
function Harness({ totalSize, tolerance }: { totalSize: number; tolerance?: number }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const stick = useStickToBottom(viewportRef, totalSize, tolerance)
  return (
    <>
      <div data-at-bottom={stick.isAtBottom ? '1' : '0'} data-testid="vp" ref={viewportRef} />
      <button data-testid="to-bottom" onClick={() => stick.scrollToBottom('auto')} type="button" />
    </>
  )
}

// Install scroll-dimension mocks on a mounted element. Returns a handle to read/
// drive scrollTop (the setter records into `state.scrollTop`).
function mockScroll(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  const state = { scrollTop: 0 }
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.scrollTop,
    set: (v: number) => {
      state.scrollTop = v
    },
  })
  return state
}

describe('useStickToBottom', () => {
  it('starts stuck at the bottom', () => {
    const { container } = render(<Harness totalSize={100} />)
    const vp = container.querySelector('[data-testid="vp"]') as HTMLDivElement
    mockScroll(vp, 1000, 200)
    expect(vp.getAttribute('data-at-bottom')).toBe('1')
  })

  it('unsticks when the user scrolls away from the bottom', () => {
    const { container } = render(<Harness totalSize={100} />)
    const vp = container.querySelector('[data-testid="vp"]') as HTMLDivElement
    const state = mockScroll(vp, 1000, 200)

    state.scrollTop = 0 // user scrolled to top
    fireEvent.scroll(vp)
    expect(vp.getAttribute('data-at-bottom')).toBe('0')
  })

  it('does NOT pin when content grows while the user is scrolled up', () => {
    const { container, rerender } = render(<Harness totalSize={100} />)
    const vp = container.querySelector('[data-testid="vp"]') as HTMLDivElement
    const state = mockScroll(vp, 1000, 200)

    state.scrollTop = 0
    fireEvent.scroll(vp) // unstuck
    const scrollToSpy = vi.spyOn(vp, 'scrollTo')

    rerender(<Harness totalSize={500} />) // content grew
    // stuck === false → layout effect must not touch scrollTop
    expect(state.scrollTop).toBe(0)
    expect(scrollToSpy).not.toHaveBeenCalled()
  })

  it('re-sticks and pins to bottom on scrollToBottom()', () => {
    const { container } = render(<Harness totalSize={100} />)
    const vp = container.querySelector('[data-testid="vp"]') as HTMLDivElement
    const state = mockScroll(vp, 1000, 200)

    state.scrollTop = 0
    fireEvent.scroll(vp) // unstuck
    expect(vp.getAttribute('data-at-bottom')).toBe('0')

    fireEvent.click(container.querySelector('[data-testid="to-bottom"]')!)
    expect(vp.getAttribute('data-at-bottom')).toBe('1')
    // scrollToBottom('auto') lands at scrollHeight.
    expect(state.scrollTop).toBe(1000)
  })

  it('re-pins to the new bottom when content grows while stuck', () => {
    const { container, rerender } = render(<Harness totalSize={100} />)
    const vp = container.querySelector('[data-testid="vp"]') as HTMLDivElement
    const state = mockScroll(vp, 1000, 200)

    // ensure stuck (initial state is stuck=true)
    fireEvent.click(container.querySelector('[data-testid="to-bottom"]')!)
    expect(state.scrollTop).toBe(1000)

    rerender(<Harness totalSize={900} />) // content grew while stuck
    expect(state.scrollTop).toBe(1000) // pinned to scrollHeight (=1000)
  })
})
```

- [ ] **Step 2: 跑测试,确认 FAIL(import 报错)**

Run: `npm test -- src/renderer/src/components/ui/stick-to-bottom-list.test.tsx`
Expected: FAIL(`useStickToBottom` 未导出 / 文件不存在)。

- [ ] **Step 3: 实现 hook**

Create `src/renderer/src/components/ui/stick-to-bottom-list.tsx`:

```tsx
// Virtualized message list that stays pinned to the bottom while new content
// streams in — the chat/transcript UX — without giving up the bounded DOM of
// `@tanstack/react-virtual`. Reuses `useVirtualList` + `<VirtualRows>` from
// virtual-list.tsx and layers a hand-rolled stick-to-bottom behavior on top.
//
// Why hand-rolled (not the `use-stick-to-bottom` lib): the library renders its
// own native-scrollbar scroller, which violates the project rule that every
// scroll container uses the styled ScrollArea. This composes ScrollArea instead.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

// `useStickToBottom` is exported for direct unit testing of its state machine.
// It reads/writes the scroll element's geometry directly; in jsdom those are 0,
// so tests mock scrollHeight/clientHeight/scrollTop on the element instance.
export function useStickToBottom(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  totalSize: number,
  tolerance = 4,
): { isAtBottom: boolean; scrollToBottom: (behavior?: ScrollBehavior) => void } {
  const [isAtBottom, setIsAtBottom] = useState(true)
  // True "should we pin" flag. Stays true until the user scrolls away from the
  // bottom; a ref (not state) so the layout effect reads the latest value without
  // waiting for a re-render.
  const stuckRef = useRef(true)
  // Suppresses the stick update during a programmatic smooth scroll: the
  // animation passes through non-bottom positions whose scroll events would
  // otherwise clear `stuckRef` mid-flight and drop a growing tail.
  const smoothScrollingRef = useRef(false)

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onScroll = () => {
      if (smoothScrollingRef.current) return
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= tolerance
      stuckRef.current = atBottom
      setIsAtBottom(atBottom)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [viewportRef, tolerance])

  // Re-pin to the bottom whenever the virtualized height changes (new message,
  // streaming tail growth, async image remeasure) — but only if still stuck.
  // useLayoutEffect so the assignment lands before paint (no flicker).
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el || !stuckRef.current) return
    el.scrollTop = el.scrollHeight
  }, [viewportRef, totalSize])

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const el = viewportRef.current
      if (!el) return
      stuckRef.current = true
      setIsAtBottom(true)
      el.scrollTo({ top: el.scrollHeight, behavior })
      if (behavior === 'smooth') {
        // Ignore scroll events we generated ourselves until the animation ends.
        smoothScrollingRef.current = true
        const reset = () => {
          smoothScrollingRef.current = false
        }
        el.addEventListener('scrollend', reset, { once: true })
        // Fallback: if scrollend never fires, clear shortly after a typical animation.
        window.setTimeout(reset, 500)
      }
    },
    [viewportRef],
  )

  return { isAtBottom, scrollToBottom }
}
```

- [ ] **Step 4: 跑测试,确认 PASS**

Run: `npm test -- src/renderer/src/components/ui/stick-to-bottom-list.test.tsx`
Expected: PASS(5 tests)。

- [ ] **Step 5: typecheck**

Run: `npm run typecheck:web`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/ui/stick-to-bottom-list.tsx src/renderer/src/components/ui/stick-to-bottom-list.test.tsx
git commit -m "feat(stick-to-bottom): add useStickToBottom state-machine hook

Tracks isAtBottom via a scroll listener, re-pins scrollTop to scrollHeight on
virtualizer totalSize change while stuck (useLayoutEffect, pre-paint), and
guards programmatic smooth-scroll events so a streaming tail isn't dropped."
```

---

## Task 3: `StickToBottomList` 组件 + context

把 hook 接到虚拟化列表上,通过 context 暴露 `isAtBottom` / `scrollToBottom`。

**Files:**
- Modify: `src/renderer/src/components/ui/stick-to-bottom-list.tsx`
- Modify: `src/renderer/src/components/ui/stick-to-bottom-list.test.tsx`(追加 smoke 测试)

**Interfaces:**
- Produces:
  - `StickToBottomListProps<T>`(见下)
  - `useStickToBottomList(): { isAtBottom: boolean; scrollToBottom: (behavior?: ScrollBehavior) => void }`(用在 Provider 子树内,否则抛错)
- Consumes: `useVirtualList` + `VirtualRows` (Task 1)、`ScrollArea` (`@/components/ui/scroll-area`)、`useStickToBottom` (Task 2)、`cn` (`@/lib/utils`)。

- [ ] **Step 1: 追加 smoke 测试(失败)**

Append to `src/renderer/src/components/ui/stick-to-bottom-list.test.tsx`(在现有 import 里追加 `useContext` 与 `StickToBottomList`、`StickToBottomListContext`;在文件底部新增 describe):

更新文件顶部 import 段为:

```tsx
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useContext, useRef } from 'react'

import { StickToBottomList, StickToBottomListContext, useStickToBottom, useStickToBottomList } from './stick-to-bottom-list'
```

在文件末尾追加:

```tsx
// A consumer that reads the context, like a "scroll to latest" button would.
function ContextProbe() {
  const ctx = useContext(StickToBottomListContext)
  return <div data-at-bottom={ctx?.isAtBottom ? '1' : '0'} data-testid="probe" />
}

// useStickToBottomList must throw when called outside the provider.
function ThrowingConsumer() {
  useStickToBottomList()
  return null
}

describe('StickToBottomList', () => {
  it('renders the ScrollArea, its items, and exposes context to children', () => {
    render(
      <StickToBottomList
        className="h-[600px]"
        getKey={(s) => s}
        items={['one', 'two']}
        renderItem={(s) => <div>{s}</div>}
      >
        <ContextProbe />
      </StickToBottomList>,
    )
    expect(document.querySelector('[data-slot="scroll-area"]')).not.toBeNull()
    expect(screen.getByText('one')).toBeInTheDocument()
    // Initial state is stuck at the bottom.
    expect(screen.getByTestId('probe').getAttribute('data-at-bottom')).toBe('1')
  })

  it('throws when useStickToBottomList is called outside the provider', () => {
    // Suppress the expected console.error from React for the thrown render.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<ThrowingConsumer />)).toThrow(/useStickToBottomList/)
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: 跑测试,确认 FAIL(组件/context 未导出)**

Run: `npm test -- src/renderer/src/components/ui/stick-to-bottom-list.test.tsx`
Expected: FAIL — `StickToBottomList` / `StickToBottomListContext` / `useStickToBottomList` 尚未导出(import 解析失败)。这是 TDD 的红阶段。

- [ ] **Step 3: 实现 `StickToBottomList` + context + `useStickToBottomList`**

Append to `src/renderer/src/components/ui/stick-to-bottom-list.tsx`(在现有 `useStickToBottom` 之后;并在文件顶部 import 段补上 `createContext, useContext, useMemo` 与 `useVirtualList`、`VirtualRows`、`ScrollArea`、`cn`):

更新文件顶部 import 段为:

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { useVirtualList, VirtualRows } from '@/components/ui/virtual-list'
import { cn } from '@/lib/utils'
```

在文件末尾追加:

```tsx
type StickToBottomListContextValue = {
  isAtBottom: boolean
  scrollToBottom: (behavior?: ScrollBehavior) => void
}

const StickToBottomListContext = createContext<StickToBottomListContextValue | null>(null)

/** Read stick state inside a <StickToBottomList> (e.g. to render a "scroll to latest" button). */
export function useStickToBottomList(): StickToBottomListContextValue {
  const ctx = useContext(StickToBottomListContext)
  if (!ctx) throw new Error('useStickToBottomList must be used within <StickToBottomList>')
  return ctx
}

type StickToBottomListProps<T> = {
  items: readonly T[]
  /** Stable identity per item — keeps the measurement cache correct. */
  getKey: (item: T, index: number) => string | number
  renderItem: (item: T, index: number) => React.ReactNode
  /** Rough average row height (px) for the first paint. */
  estimateSize?: number
  /** Rows rendered beyond each viewport edge. */
  overscan?: number
  /** Vertical gap between rows (px). */
  gap?: number
  /** Class for the wrapper — it owns the scroll height (e.g. "min-h-0 flex-1"). */
  className?: string
  /** Show top/bottom edge fades on the ScrollArea. */
  edgeFade?: boolean
  /** Px within which scrollTop counts as "at the bottom". */
  bottomTolerance?: number
  /** Overlays rendered above the list (e.g. a scroll-to-latest button). */
  children?: React.ReactNode
}

export function StickToBottomList<T>({
  items,
  getKey,
  renderItem,
  estimateSize,
  overscan,
  gap,
  className,
  edgeFade = false,
  bottomTolerance,
  children,
}: StickToBottomListProps<T>): React.JSX.Element {
  const { viewportRef, virtualizer } = useVirtualList({ items, getKey, estimateSize, overscan, gap })
  const totalSize = virtualizer.getTotalSize()
  const { isAtBottom, scrollToBottom } = useStickToBottom(viewportRef, totalSize, bottomTolerance)

  const ctx = useMemo(
    () => ({ isAtBottom, scrollToBottom }),
    [isAtBottom, scrollToBottom],
  )

  return (
    <StickToBottomListContext.Provider value={ctx}>
      {/* relative wrapper so a consumer's absolute-positioned button (e.g. bottom
          center) anchors against the list, not the page. */}
      <div className={cn('relative', className)}>
        <ScrollArea className="size-full" edgeFade={edgeFade} viewportRef={viewportRef}>
          <VirtualRows items={items} renderItem={renderItem} virtualizer={virtualizer} />
        </ScrollArea>
        {children}
      </div>
    </StickToBottomListContext.Provider>
  )
}
```

- [ ] **Step 4: 跑全部测试**

Run: `npm test -- src/renderer/src/components/ui/stick-to-bottom-list.test.tsx`
Expected: PASS(hook 5 + 组件 2 = 7 tests)。

- [ ] **Step 5: typecheck + biome**

Run: `npm run typecheck:web`
Expected: 无错误。

Run: `npx biome check --write src/renderer/src/components/ui/stick-to-bottom-list.tsx src/renderer/src/components/ui/stick-to-bottom-list.test.tsx`
Expected: 格式化通过。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/ui/stick-to-bottom-list.tsx src/renderer/src/components/ui/stick-to-bottom-list.test.tsx
git commit -m "feat(stick-to-bottom): add StickToBottomList component + context

Composes useVirtualList + <VirtualRows> with useStickToBottom, exposing
isAtBottom/scrollToBottom via context so consumers render their own
scroll-to-latest button. No built-in button — the primitive stays UI-agnostic."
```

---

## Task 4: 手动 playtest 验证(真实滚动)

jsdom 不做布局,**无法**自动验证真实滚动几何。这一步在真实 Electron 里验证吸底手感。**临时挂载点验证后还原;`stick-to-bottom-playground.tsx` 是 throwaway,不提交。**

**Files:**
- Create (throwaway, do NOT commit): `src/renderer/src/components/ui/stick-to-bottom-playground.tsx`
- Modify (temporarily, then revert): 选一个**开发期易到达**的视图临时挂载 playground。建议 `src/renderer/src/components/views/bilibili-view.tsx` 或 `trending-view.tsx` 顶部临时插入 `<StickToBottomPlayground />`(这俩视图已用 `VirtualList`,布局容器现成)。**具体挂载文件与行由执行者在 app 里确认能打开该视图后决定;playtest 完成后 `git checkout -- <file>` 还原。**

**Interfaces:** 无新接口(消费 Task 3 的 `StickToBottomList` + `useStickToBottomList`)。

- [ ] **Step 1: 写 throwaway playground**

Create `src/renderer/src/components/ui/stick-to-bottom-playground.tsx`:

```tsx
// THROWAWAY: manual playtest harness for <StickToBottomList>. Not committed.
// Simulates a streaming chat: a button appends a row; stick-to-bottom should
// keep the view pinned while at the bottom and stop pinning once you scroll up.
import { useState } from 'react'
import { ArrowDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { StickToBottomList, useStickToBottomList } from '@/components/ui/stick-to-bottom-list'

function ScrollToLatest() {
  const { isAtBottom, scrollToBottom } = useStickToBottomList()
  if (isAtBottom) return null
  return (
    <Button
      className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full"
      onClick={() => scrollToBottom()}
      size="icon"
      variant="outline"
    >
      <ArrowDown className="size-4" />
    </Button>
  )
}

export function StickToBottomPlayground() {
  const [items, setItems] = useState(
    () => Array.from({ length: 40 }, (_, i) => ({ id: `${i}`, text: `row ${i}` })),
  )
  return (
    <div className="flex h-[600px] flex-col gap-2 border p-2">
      <Button
        onClick={() =>
          setItems((prev) => [...prev, { id: `${prev.length}`, text: `row ${prev.length} (new)` }])
        }
        size="sm"
        variant="secondary"
      >
        Append row (simulate stream)
      </Button>
      <StickToBottomList
        className="min-h-0 flex-1 border"
        getKey={(it) => it.id}
        items={items}
        renderItem={(it) => (
          <div className="border-b p-3" style={{ height: it.text.includes('new') ? 120 : 60 }}>
            {it.text}
          </div>
        )}
      >
        <ScrollToLatest />
      </StickToBottomList>
    </div>
  )
}
```

- [ ] **Step 2: 临时挂载到一个能打开的视图**

在选定的视图文件顶部 import:`import { StickToBottomPlayground } from '@/components/ui/stick-to-bottom-playground'`,并在其返回的 JSX 里临时插入 `<StickToBottomPlayground />`(放在能看见的位置)。**记下你改的文件,稍后还原。**

- [ ] **Step 3: 启动 app,逐条核对清单**

Run: `pnpm dev`(或用 run-desktop skill 启动)。打开挂载了 playground 的视图,核对:

- [ ] 首屏自动停在底部(最后一条可见)。
- [ ] 连点 "Append row" 若干次:视口保持钉在底部、新行平滑进入、**无跳动/闪烁**。
- [ ] 向上滚动一段 → 停止钉底;"回到底部"按钮(ArrowDown)出现。
- [ ] 上滚状态下继续点 "Append row":视口**不被**拽下去(不打扰用户)。
- [ ] 点 "回到底部" → 平滑回到底部、按钮消失、恢复钉底。
- [ ] 高度变化的行(标了 `(new)` 的 120px 行)出现后,吸底不被破坏、无错位。

任一条不过 → 回到 Task 2/3 修 hook,不要放过。

- [ ] **Step 4: 还原临时挂载,丢弃 throwaway**

```bash
git checkout -- <你在 Step 2 改的视图文件>
rm src/renderer/src/components/ui/stick-to-bottom-playground.tsx
git status   # 确认只剩 Task 1-3 的提交,无 playground / 视图改动残留
```

- [ ] **Step 5: 最终回归**

Run: `npm run typecheck:web && npm test -- src/renderer/src/components/ui/`
Expected: typecheck 无错、virtual-list + stick-to-bottom-list 测试全绿。

(本任务无 commit——产物是验证结论 + 还原后的干净树。把 playtest 结果以文字反馈给评审者。)

---

## Self-Review(plan 作者自查记录)

**Spec coverage:**
- §2 决策(通用原语 / 手写吸底 / list+context / 共享 helper)→ Task 1+2+3 全覆盖。
- §4.1 `useVirtualList` + `<VirtualRows>` → Task 1。
- §4.2 + §5 组件 API + context → Task 3。
- §6 吸底 hook(layout effect 依赖 totalSize、stuckRef、programmatic 平滑滚动守卫)→ Task 2(含 §7 的 programmaticRef 注记已并入实现)。
- §7 限制(视口上方变高不补偿)→ 非代码,spec 已声明;playground 用尾部追加验证主路径。
- §8 测试(hook 状态机单测 + playtest)→ Task 2 单测 + Task 4 playtest;jsdom 不能测真实滚动已在 Task 4 开头诚实声明。

**Placeholder scan:** 无 TBD/TODO;每步含完整代码或确切命令与预期输出。Task 4 Step 2 的"具体视图文件由执行者定"是有意为之(playtest 需选一个能在 app 里打开的视图),已给出候选与还原命令,非占位。

**Type consistency:** `VirtualizerInstance` / `useVirtualList` / `VirtualRows` / `useStickToBottom` / `StickToBottomList` / `StickToBottomListContext` / `useStickToBottomList` 在各 task 间命名与签名一致;`scrollToBottom(behavior?: ScrollBehavior)` 默认 `'smooth'`,测试用 `'auto'` 避开 jsdom 无法驱动平滑动画的问题。
