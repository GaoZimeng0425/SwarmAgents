import { afterEach, describe, expect, it, vi } from 'vitest'
import { htmlToMarkdown, isPrivateHost, webFetchSpec } from './web'
import type { ToolRunContext } from './registry'

const ctx: ToolRunContext = {
  taskId: 't',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  send: () => undefined,
  requestPermission: async () => 'grant',
}
const tool = () => webFetchSpec().build(ctx)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isPrivateHost', () => {
  it('flags loopback, private, link-local and .local hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '::1', 'box.local']) {
      expect(isPrivateHost(h)).toBe(true)
    }
  })
  it('passes public hosts', () => {
    for (const h of ['example.com', '1.1.1.1', 'github.com']) {
      expect(isPrivateHost(h)).toBe(false)
    }
  })
})

describe('webFetchSpec risk', () => {
  it('is low for public https and high for private/non-http/garbage', () => {
    const spec = webFetchSpec()
    expect(spec.riskFor!({ url: 'https://example.com/page' })).toBe('low')
    expect(spec.riskFor!({ url: 'http://localhost:8080' })).toBe('high')
    expect(spec.riskFor!({ url: 'file:///etc/passwd' })).toBe('high')
    expect(spec.riskFor!({ url: 'not a url' })).toBe('high')
  })
})

describe('htmlToMarkdown', () => {
  it('returns markdown that preserves headings and links', () => {
    const html =
      '<html><body><article><h1>Title</h1><p>Hello <a href="https://x.com/">link</a>.</p></article></body></html>'
    const md = htmlToMarkdown(html, 'https://example.com')
    expect(md).toContain('Title')
    expect(md).toContain('[link](https://x.com/)')
  })
})

describe('web fetch tool', () => {
  it('rejects non-http(s) schemes without fetching', async () => {
    const res = await tool().execute('c', { url: 'file:///etc/passwd' })
    expect((res.details as { error?: string }).error).toMatch(/http/i)
  })

  it('fetches HTML and returns extracted markdown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<article><h1>Doc Heading</h1><p>Some body content here.</p></article>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
      )
    )
    const res = await tool().execute('c', { url: 'https://example.com' })
    expect(res.content[0].text).toContain('Doc Heading')
    expect((res.details as { status: number }).status).toBe(200)
  })

  it('returns JSON / plain text bodies as-is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } })
      )
    )
    const res = await tool().execute('c', { url: 'https://api.example.com/x' })
    expect(res.content[0].text).toContain('"a":1')
  })

  it('returns the raw body when raw is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<h1>raw</h1>', { status: 200, headers: { 'content-type': 'text/html' } }))
    )
    const res = await tool().execute('c', { url: 'https://example.com', raw: true })
    expect(res.content[0].text).toContain('<h1>raw</h1>')
  })

  it('surfaces a network error as a result, not a throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      })
    )
    const res = await tool().execute('c', { url: 'https://example.com' })
    expect((res.details as { error?: string }).error).toMatch(/boom/i)
  })
})
