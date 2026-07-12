// Bookmarks view. Calls chrome.bookmarks.getTree() directly (no background
// relay — there is no real-time requirement). Renders a recursive tree with
// expand/collapse; first-level folders are expanded by default. The RawJson
// region at the bottom shows the unmodified API payload.
import { type JSX, useEffect, useState } from 'react'

import type { BookmarkNode } from '../../lib/bookmarks'
import { getBookmarks } from '../../lib/bookmarks'
import { RawJson } from './RawJson'

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function shortDate(ms: number): string {
  try {
    const d = new Date(ms)
    return `${d.getMonth() + 1}月${d.getDate()}日`
  } catch {
    return ''
  }
}

// Recursive tree node renderer. Folders toggle expand; leaves link out.
function BookmarkItem({
  node,
  expanded,
  onToggle,
}: {
  node: BookmarkNode
  expanded: Set<string>
  onToggle: (id: string) => void
}): JSX.Element {
  const isFolder = node.children !== undefined
  const isOpen = expanded.has(node.id)
  return (
    <div className="flex flex-col">
      <button
        className="flex items-center gap-1 rounded px-1.5 py-1 text-left text-xs hover:bg-sidebar-accent"
        onClick={() => isFolder && onToggle(node.id)}
        type="button"
      >
        {isFolder ? (
          <span className="w-3 text-[10px] text-muted-foreground">{isOpen ? '▼' : '▶'}</span>
        ) : (
          <span className="w-3 text-[10px] text-muted-foreground">•</span>
        )}
        <span className={isFolder ? 'font-medium' : ''}>{node.title || '(未命名)'}</span>
        {!isFolder && node.url ? (
          <span className="truncate text-[10px] text-muted-foreground">{hostnameOf(node.url)}</span>
        ) : null}
        {!isFolder && node.dateAdded ? (
          <span className="ml-auto text-[10px] text-muted-foreground">{shortDate(node.dateAdded)}</span>
        ) : null}
      </button>
      {isFolder && isOpen ? (
        <div className="ml-3 border-border border-l pl-1">
          {node.children!.map((child) => (
            <BookmarkItem expanded={expanded} key={child.id} node={child} onToggle={onToggle} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function BookmarksTab(): JSX.Element {
  const [tree, setTree] = useState<BookmarkNode[]>([])
  const [raw, setRaw] = useState<chrome.bookmarks.BookmarkTreeNode[]>([])
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = (): void => {
    setError(null)
    getBookmarks()
      .then(({ tree, raw }) => {
        setTree(tree)
        setRaw(raw)
        // Expand top-level folders by default on first load.
        setExpanded(new Set(tree.filter((n) => n.children !== undefined).map((n) => n.id)))
      })
      .catch((err) => setError(String(err)))
  }

  useEffect(() => {
    load()
  }, [])

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const count = tree.reduce((acc, n) => acc + (n.children?.length ?? 0), 0)

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          <span className="tabular-nums">{count}</span> 个书签
        </p>
        <button className="text-muted-foreground text-xs underline" onClick={load} type="button">
          刷新
        </button>
      </div>
      {error ? <p className="text-destructive text-xs">加载失败:{error}</p> : null}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {tree.length === 0 && !error ? <p className="text-muted-foreground text-xs">没有书签。</p> : null}
        {tree.map((node) => (
          <BookmarkItem expanded={expanded} key={node.id} node={node} onToggle={toggle} />
        ))}
      </div>
      <RawJson data={raw} label="原始书签 JSON" />
    </section>
  )
}
