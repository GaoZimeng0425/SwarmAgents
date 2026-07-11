import type { WebSearchInjection } from '@swarm/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ToolRunContext } from './registry'
import {
  htmlToMarkdown,
  isPrivateHost,
  pickSearchProvider,
  resolveSearchConfig,
  webFetchSpec,
  webSearchSpec,
} from './web'

const ctx: ToolRunContext = {
  sessionId: 's',
  taskId: 't',
  spawnChild: async () => ({ messageId: 'c', status: 'completed', summary: '', artifacts: [] }),
  requestPermission: async () => 'grant',
  findPeers: () => [],
}
const tool = () => webFetchSpec().build(ctx)

/** Narrow a content item to its text, matching mcp/manager.ts:textOf. */
const textOf = (c: { type: string; text?: string }): string => (c.type === 'text' ? (c.text ?? '') : '')

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
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
    expect(textOf(res.content[0])).toContain('Doc Heading')
    expect((res.details as { status: number }).status).toBe(200)
  })

  it('returns JSON / plain text bodies as-is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }))
    )
    const res = await tool().execute('c', { url: 'https://api.example.com/x' })
    expect(textOf(res.content[0])).toContain('"a":1')
  })

  it('returns the raw body when raw is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<h1>raw</h1>', { status: 200, headers: { 'content-type': 'text/html' } }))
    )
    const res = await tool().execute('c', { url: 'https://example.com', raw: true })
    expect(textOf(res.content[0])).toContain('<h1>raw</h1>')
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

const searchTool = (cfg: WebSearchInjection) => webSearchSpec(() => cfg).build(ctx)

const clearSearchEnv = (): void => {
  for (const k of ['TAVILY_API_KEY', 'BRAVE_API_KEY', 'SEARXNG_URL']) {
    vi.stubEnv(k, '')
  }
}

describe('pickSearchProvider', () => {
  it('honors an explicit provider choice', () => {
    expect(pickSearchProvider({ provider: 'brave' }).name).toBe('brave')
  })

  it('auto-detects the first available keyed provider', () => {
    expect(pickSearchProvider({ provider: 'auto', braveKey: 'k' }).name).toBe('brave')
  })

  it('falls back to duckduckgo when nothing is configured', () => {
    expect(pickSearchProvider({ provider: 'auto' }).name).toBe('duckduckgo')
  })
})

describe('resolveSearchConfig', () => {
  it('prefers the configured key over the env fallback', () => {
    vi.stubEnv('BRAVE_API_KEY', 'envk')
    expect(resolveSearchConfig({ provider: 'auto', braveKey: 'uik' }).braveKey).toBe('uik')
  })

  it('falls back to the env var when no key is configured', () => {
    vi.stubEnv('BRAVE_API_KEY', 'envk')
    expect(resolveSearchConfig({ provider: 'auto' }).braveKey).toBe('envk')
  })
})

describe('web search tool', () => {
  it('returns an error for an empty query without searching', async () => {
    const res = await searchTool({ provider: 'auto' }).execute('c', { query: '   ' })
    expect((res.details as { error?: string }).error).toMatch(/empty/i)
  })

  it('formats brave JSON results as a numbered list', async () => {
    clearSearchEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              web: {
                results: [
                  { title: 'A', url: 'https://a.com', description: 'first' },
                  { title: 'B', url: 'https://b.com', description: 'second' },
                ],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    )
    const res = await searchTool({ provider: 'brave', braveKey: 'k' }).execute('c', { query: 'hello' })
    expect(textOf(res.content[0])).toContain('1. A')
    expect(textOf(res.content[0])).toContain('https://a.com')
    expect((res.details as { provider: string }).provider).toBe('brave')
  })

  it('surfaces a provider HTTP error as a result, not a throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500, statusText: 'Server Error' }))
    )
    const res = await searchTool({ provider: 'brave', braveKey: 'k' }).execute('c', { query: 'hello' })
    expect((res.details as { error?: string }).error).toMatch(/brave: 500/)
  })

  it('parses duckduckgo HTML results and decodes redirect URLs', async () => {
    const html =
      '<div class="result">' +
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx&rut=abc">Example</a>' +
      '<div class="result__snippet">a snippet</div>' +
      '</div>'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }))
    )
    const res = await searchTool({ provider: 'duckduckgo' }).execute('c', { query: 'hello' })
    expect(textOf(res.content[0])).toContain('Example')
    expect(textOf(res.content[0])).toContain('https://example.com/x')
  })
})
