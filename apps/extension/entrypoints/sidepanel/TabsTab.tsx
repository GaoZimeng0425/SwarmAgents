// Tabs view. On mount, requests a snapshot from the background (which owns the
// tabs store) and subscribes to live `tabs:changed` deltas. The projected
// render updates live; the RawJson region shows the initial snapshot payload
// statically (labeled with a timestamp) per spec §14 — deltas do not refresh it.
//
// Listener hygiene: the onMessage listener is a named function reference so it
// can be removed cleanly on unmount (Acceptance §10.7). An inline arrow would
// leak.
import { type JSX, useEffect, useState } from 'react'

import { TABS_MSG, type TabInfo, type WindowTabs } from '../../lib/tabs-shared'
import { RawJson } from './RawJson'

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function TabsTab(): JSX.Element {
  const [windows, setWindows] = useState<WindowTabs[]>([])
  const [rawSnapshot, setRawSnapshot] = useState<unknown>(null)
  const [snapshotAt, setSnapshotAt] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  const refresh = (): void => {
    setError(null)
    browser.runtime.sendMessage({ type: TABS_MSG.getSnapshot }, (r) => {
      if (r?.type === TABS_MSG.snapshot) {
        setWindows(r.windows)
        setRawSnapshot(r)
        setSnapshotAt(new Date().toLocaleTimeString())
      } else if (r?.type === TABS_MSG.snapshotError) {
        setError(r.error ?? '快照获取失败')
      }
    })
  }

  useEffect(() => {
    // Named listener for clean removal. Applies a `tabs:changed` delta to the
    // local copy of the windows snapshot.
    const onMsg = (msg: { type?: string; kind?: string; tab?: TabInfo }): void => {
      if (msg?.type !== TABS_MSG.changed || !msg.tab) return
      const tab = msg.tab
      const kind = msg.kind as 'created' | 'updated' | 'removed' | 'activated'
      setWindows((prev) => {
        let next = prev.map((w) => ({ ...w, tabs: [...w.tabs] }))
        if (kind === 'removed') {
          next = next
            .map((w) => ({ ...w, tabs: w.tabs.filter((t) => t.id !== tab.id) }))
            .filter((w) => w.tabs.length > 0)
          return next
        }
        if (kind === 'activated') {
          next = next.map((w) => ({
            ...w,
            tabs: w.tabs.map((t) => ({ ...t, active: t.id === tab.id })),
          }))
          return next
        }
        // created or updated: upsert into the tab's window group.
        let found = false
        next = next.map((w) => {
          if (w.windowId !== tab.windowId) return w
          const idx = w.tabs.findIndex((t) => t.id === tab.id)
          if (idx >= 0) {
            w.tabs[idx] = tab
            found = true
          }
          return w
        })
        if (!found) {
          const existing = next.find((w) => w.windowId === tab.windowId)
          if (existing) {
            existing.tabs.push(tab)
          } else {
            next.push({ windowId: tab.windowId, incognito: false, tabs: [tab] })
          }
        }
        return next
      })
    }

    refresh()
    browser.runtime.onMessage.addListener(onMsg)
    return () => {
      browser.runtime.onMessage.removeListener(onMsg)
    }
  }, [])

  const totalTabs = windows.reduce((acc, w) => acc + w.tabs.length, 0)

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          <span className="tabular-nums">{windows.length}</span> 窗口 ·{' '}
          <span className="tabular-nums">{totalTabs}</span> 标签页
        </p>
        <button className="text-muted-foreground text-xs underline" onClick={refresh} type="button">
          刷新
        </button>
      </div>
      {error ? <p className="text-destructive text-xs">快照获取失败:{error}</p> : null}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {windows.length === 0 && !error ? <p className="text-muted-foreground text-xs">没有打开的标签页。</p> : null}
        {windows.map((w) => (
          <details key={w.windowId} open>
            <summary className="cursor-pointer select-none text-muted-foreground text-xs">
              窗口 {w.windowId} · {w.incognito ? '隐身' : '普通'}
            </summary>
            <div className="mt-1 ml-2 flex flex-col gap-0.5 border-border border-l pl-2">
              {w.tabs.map((t) => (
                <div className="flex items-center gap-1.5 px-1 py-0.5 text-xs" key={t.id}>
                  {t.active ? (
                    <span className="text-[10px] text-primary">●</span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">○</span>
                  )}
                  <span className={t.active ? 'font-medium' : ''}>{t.title || '(加载中)'}</span>
                  <span className="truncate text-[10px] text-muted-foreground">{hostnameOf(t.url)}</span>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
      <RawJson data={rawSnapshot} label={`原始标签页 JSON (快照于 ${snapshotAt})`} />
    </section>
  )
}
