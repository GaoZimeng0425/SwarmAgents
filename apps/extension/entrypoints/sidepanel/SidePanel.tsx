// The extension's side panel shell. Owns only the health probe (connection
// state) and the tab switcher. Each tab (articles / bookmarks / tabs) is a
// self-contained component. The tab switcher is always visible — bookmarks and
// tabs work without a WS connection; only the articles tab needs one.
import { type JSX, useEffect, useState } from 'react'

import { ArticlesTab } from './ArticlesTab'

type Tab = 'articles' | 'bookmarks' | 'tabs'
type HealthResult = { ok: true; count: number } | { ok: false; error: string }

export function SidePanel(): JSX.Element {
  const [connected, setConnected] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('articles')

  useEffect(() => {
    let stopped = false
    const probe = (): void => {
      browser.runtime.sendMessage({ type: 'health' }, (r: HealthResult) => {
        if (stopped) return
        if (r?.ok) setConnected(true)
        else {
          setConnected(false)
          setTimeout(probe, 3000)
        }
      })
    }
    probe()
    return () => {
      stopped = true
    }
  }, [])

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <header className="flex flex-col gap-1">
        <h3 className="font-semibold text-foreground">SwarmAgents</h3>
        <p className="text-muted-foreground text-xs">连接桌面端,收集并查看文章分析。</p>
      </header>

      <nav className="flex gap-1 border-border border-b pb-2">
        {(['articles', 'bookmarks', 'tabs'] as const).map((t) => (
          <button
            className={`rounded px-2 py-1 text-xs transition-colors ${
              activeTab === t
                ? 'bg-sidebar-accent font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            key={t}
            onClick={() => setActiveTab(t)}
            type="button"
          >
            {t === 'articles' ? '文章' : t === 'bookmarks' ? '书签' : '标签页'}
          </button>
        ))}
      </nav>

      {activeTab === 'articles' && <ArticlesTab connected={connected} />}
      {activeTab === 'bookmarks' && <p className="text-muted-foreground text-xs">(书签视图即将上线)</p>}
      {activeTab === 'tabs' && <p className="text-muted-foreground text-xs">(标签页视图即将上线)</p>}
    </div>
  )
}
