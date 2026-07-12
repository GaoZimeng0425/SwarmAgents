import { describe, expect, it } from 'vitest'

import { toBookmarkNodes } from './bookmarks'

// Minimal fake matching the shape chrome.bookmarks.getTree() returns. We cast
// through unknown so the test doesn't depend on @types/chrome's full type.
type RawNode = {
  id: string
  title: string
  url?: string
  children?: RawNode[]
  dateAdded?: number
}

describe('toBookmarkNodes', () => {
  it('projects a root folder with nested bookmarks and subfolders', () => {
    const raw: RawNode[] = [
      {
        id: '1',
        title: '书签栏',
        children: [
          { id: '2', title: 'GitHub', url: 'https://github.com', dateAdded: 1700000000000 },
          {
            id: '3',
            title: '开发',
            children: [{ id: '4', title: 'MDN', url: 'https://developer.mozilla.org' }],
          },
        ],
      },
    ]
    const tree = toBookmarkNodes(raw as unknown as chrome.bookmarks.BookmarkTreeNode[])
    expect(tree).toHaveLength(1)
    expect(tree[0].title).toBe('书签栏')
    expect(tree[0].children).toHaveLength(2)
    expect(tree[0].children![0]).toMatchObject({ id: '2', title: 'GitHub', url: 'https://github.com' })
    expect(tree[0].children![1].children).toHaveLength(1)
    expect(tree[0].children![1].children![0].title).toBe('MDN')
  })

  it('preserves dateAdded and treats nodes without url as folders', () => {
    const raw: RawNode[] = [
      {
        id: '1',
        title: 'root',
        dateAdded: 1700000000000,
        children: [{ id: '2', title: 'folder-no-date' }],
      },
    ]
    const tree = toBookmarkNodes(raw as unknown as chrome.bookmarks.BookmarkTreeNode[])
    expect(tree[0].dateAdded).toBe(1700000000000)
    expect(tree[0].children![0].url).toBeUndefined()
    expect(tree[0].children![0].children).toBeUndefined()
  })

  it('handles an empty tree', () => {
    expect(toBookmarkNodes([])).toEqual([])
  })
})
