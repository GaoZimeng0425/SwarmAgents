// Bookmarks data layer. getBookmarks() calls chrome.bookmarks.getTree() and
// returns both the projected tree (for rendering) and the raw API payload (for
// the RawJson debug region). toBookmarkNodes is the pure projection, tested in
// isolation.

export type BookmarkNode = {
  id: string
  title: string
  url?: string // absent => folder
  children?: BookmarkNode[]
  dateAdded?: number
}

// Project the raw chrome.bookmarks.BookmarkTreeNode[] into a leaner tree that
// preserves the hierarchy. Drops fields the view doesn't need (index,
// parentId, dateGroupModified, etc.) but keeps id/title/url/children/dateAdded.
export function toBookmarkNodes(raw: chrome.bookmarks.BookmarkTreeNode[]): BookmarkNode[] {
  return raw.map((node) => {
    const out: BookmarkNode = { id: node.id, title: node.title }
    if (node.url !== undefined) out.url = node.url
    if (node.dateAdded !== undefined) out.dateAdded = node.dateAdded
    if (node.children) out.children = toBookmarkNodes(node.children)
    return out
  })
}

export async function getBookmarks(): Promise<{
  tree: BookmarkNode[]
  raw: chrome.bookmarks.BookmarkTreeNode[]
}> {
  const raw = await chrome.bookmarks.getTree()
  return { tree: toBookmarkNodes(raw), raw }
}
