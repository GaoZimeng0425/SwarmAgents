import { describe, expect, it } from 'vitest'

import { basename, extractImagePaths, isImagePath } from './file-paths'
import { remarkFilePaths } from './remark-file-paths'

describe('extractImagePaths', () => {
  it('extracts a ~ path and ignores the bare basename mention', () => {
    const text = '保存位置：~/Desktop/desktop_screenshot.png（即桌面上名为 desktop_screenshot.png 的文件）'
    expect(extractImagePaths(text)).toEqual(['~/Desktop/desktop_screenshot.png'])
  })
  it('extracts an absolute image path', () => {
    expect(extractImagePaths('saved to /Users/a/shot.jpeg done')).toEqual(['/Users/a/shot.jpeg'])
  })
  it('does not match slashes inside a URL', () => {
    expect(extractImagePaths('see https://example.com/pic.png')).toEqual([])
  })
  it('ignores non-image paths', () => {
    expect(extractImagePaths('wrote /Users/a/notes.txt')).toEqual([])
  })
})

describe('isImagePath / basename', () => {
  it('detects image extensions', () => {
    expect(isImagePath('/x/y.PNG')).toBe(true)
    expect(isImagePath('/x/y.txt')).toBe(false)
  })
  it('takes the last path segment', () => {
    expect(basename('~/Desktop/desktop_screenshot.png')).toBe('desktop_screenshot.png')
  })
})

describe('remarkFilePaths', () => {
  it('rewrites a bare path text node into a link labelled by basename', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'see ~/a.png ok' }] }],
    }
    remarkFilePaths()(tree)
    const para = tree.children[0] as { children: Array<{ type: string; url?: string; children?: { value: string }[] }> }
    expect(para.children).toHaveLength(3)
    expect(para.children[0]).toMatchObject({ type: 'text', value: 'see ' })
    expect(para.children[1]).toMatchObject({ type: 'link', url: 'swarmfile:~/a.png' })
    expect(para.children[1].children?.[0].value).toBe('a.png')
    expect(para.children[2]).toMatchObject({ type: 'text', value: ' ok' })
  })

  it('leaves paths inside inline code untouched', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'inlineCode', value: '~/a.png' }] }],
    }
    remarkFilePaths()(tree)
    const para = tree.children[0] as { children: Array<{ type: string }> }
    expect(para.children[0].type).toBe('inlineCode')
  })
})
