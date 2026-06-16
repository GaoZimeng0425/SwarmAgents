import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { Readability } from '@mozilla/readability'
import type { WebSearchInjection } from '@shared/types/web-search'
import { JSDOM } from 'jsdom'
import TurndownService from 'turndown'

import type { ToolRisk, ToolRunContext, ToolSpec } from './registry'

const MAX_OUTPUT = 16_000
const TIMEOUT_MS = 20_000
const USER_AGENT = 'SwarmAgents/1.0 (+https://github.com/swarmagents)'

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const IPV4_PRIVATE = /^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|172\.(1[6-9]|2\d|3[01])\.)/

// SSRF guard input for riskFor: loopback / private / link-local hosts escalate
// to the permission prompt. Not a hard block — the prompt is the real gate.
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.local')) return true
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  return IPV4_PRIVATE.test(h)
}

function fetchRisk(args: unknown): ToolRisk {
  const url = (args as { url?: string }).url ?? ''
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'high'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'high'
  return isPrivateHost(u.hostname) ? 'high' : 'low'
}

// HTML → clean Markdown: Readability extracts the main article (dropping nav/
// ads/scripts); Turndown converts that to Markdown, preserving headings and
// links. Falls back to the full body when Readability can't isolate content
// (e.g. very short pages).
export function htmlToMarkdown(html: string, url: string): string {
  const dom = new JSDOM(html, { url })
  let title = ''
  let contentHtml = dom.window.document.body?.innerHTML ?? html
  try {
    const article = new Readability(dom.window.document).parse()
    if (article?.content) {
      contentHtml = article.content
      title = article.title ?? ''
    }
  } catch {
    // keep the body fallback
  }
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  const md = turndown.turndown(contentHtml).trim()
  return title ? `# ${title}\n\n${md}` : md
}

const FetchParams = Type.Object({
  url: Type.String({ description: 'The http(s) URL to fetch.' }),
  raw: Type.Optional(Type.Boolean({ description: 'Return the raw response body instead of extracted Markdown.' })),
})

export function webFetchSpec(): ToolSpec {
  return {
    group: 'web',
    name: 'fetch',
    risk: 'low',
    riskFor: fetchRisk,
    source: 'builtin',
    build: (_ctx: ToolRunContext): AgentTool => ({
      name: 'fetch',
      label: 'Fetch URL',
      description:
        'Fetch an http(s) URL and return the page as clean Markdown (main content extracted). ' +
        'JSON/text bodies are returned as-is. Pass raw:true for the unprocessed body.',
      parameters: FetchParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { url: string; raw?: boolean }
        let u: URL
        try {
          u = new URL(p.url)
        } catch {
          return err(`invalid URL: ${p.url}`)
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return err(`unsupported scheme (only http/https): ${u.protocol}`)
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
        try {
          const res = await fetch(p.url, {
            signal: controller.signal,
            redirect: 'follow',
            headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json,text/plain,*/*' },
          })
          const contentType = res.headers.get('content-type') ?? ''
          const body = await res.text()
          let text = p.raw ? body : contentType.includes('html') ? htmlToMarkdown(body, p.url) : body
          const truncated = text.length > MAX_OUTPUT
          if (truncated) text = `${text.slice(0, MAX_OUTPUT)}\n…[truncated]`
          return ok(text || '(empty body)', { status: res.status, contentType, url: p.url, truncated })
        } catch (e) {
          const msg =
            e instanceof Error && e.name === 'AbortError'
              ? `timed out after ${TIMEOUT_MS}ms`
              : e instanceof Error
                ? e.message
                : String(e)
          return err(msg)
        } finally {
          clearTimeout(timer)
        }
      },
    }),
  }
}

// ─── web search ──────────────────────────────────────────────────────────────

const SEARCH_TIMEOUT_MS = 15_000
const DEFAULT_COUNT = 5
const MAX_COUNT = 10

export type SearchResult = { title: string; url: string; snippet: string }

// Per-call config with secrets resolved: UI-configured key/URL first, then the
// matching env var as a fallback (so env-only setups keep working).
export type ResolvedSearchConfig = {
  provider: WebSearchInjection['provider']
  tavilyKey?: string
  braveKey?: string
  searxngUrl?: string
}

export function resolveSearchConfig(cfg: WebSearchInjection): ResolvedSearchConfig {
  const pick = (configured: string | undefined, env: string | undefined): string | undefined =>
    configured?.trim() || env?.trim() || undefined
  return {
    provider: cfg.provider,
    tavilyKey: pick(cfg.tavilyKey, process.env.TAVILY_API_KEY),
    braveKey: pick(cfg.braveKey, process.env.BRAVE_API_KEY),
    searxngUrl: pick(cfg.searxngUrl, process.env.SEARXNG_URL),
  }
}

// A swappable search backend. `name` routes selection; `isAvailable` is a cheap,
// network-free check (is its key/URL present in the resolved config?); `search`
// runs the query. Mirrors Hermes' WebSearchProvider — adding a source is one object.
export interface SearchProvider {
  name: Exclude<WebSearchInjection['provider'], 'auto'>
  isAvailable(cfg: ResolvedSearchConfig): boolean
  search(query: string, count: number, cfg: ResolvedSearchConfig): Promise<SearchResult[]>
}

// Shared GET/POST → JSON with a timeout. AbortSignal.timeout throws a
// TimeoutError; non-2xx becomes an Error so providers don't parse error bodies.
async function searchJson(url: string | URL, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

const tavilyProvider: SearchProvider = {
  name: 'tavily',
  isAvailable: (cfg) => !!cfg.tavilyKey,
  async search(query, count, cfg) {
    const json = (await searchJson('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.tavilyKey ?? ''}`,
      },
      body: JSON.stringify({ query, max_results: count }),
    })) as { results?: { title: string; url: string; content?: string }[] }
    return (json.results ?? []).slice(0, count).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content ?? '',
    }))
  },
}

const braveProvider: SearchProvider = {
  name: 'brave',
  isAvailable: (cfg) => !!cfg.braveKey,
  async search(query, count, cfg) {
    const u = new URL('https://api.search.brave.com/res/v1/web/search')
    u.searchParams.set('q', query)
    u.searchParams.set('count', String(count))
    const json = (await searchJson(u, {
      headers: { accept: 'application/json', 'x-subscription-token': cfg.braveKey ?? '' },
    })) as { web?: { results?: { title: string; url: string; description?: string }[] } }
    return (json.web?.results ?? []).slice(0, count).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description ?? '',
    }))
  },
}

const searxngProvider: SearchProvider = {
  name: 'searxng',
  isAvailable: (cfg) => !!cfg.searxngUrl,
  async search(query, count, cfg) {
    const u = new URL('/search', cfg.searxngUrl ?? '')
    u.searchParams.set('q', query)
    u.searchParams.set('format', 'json')
    const json = (await searchJson(u, { headers: { accept: 'application/json' } })) as {
      results?: { title: string; url: string; content?: string }[]
    }
    return (json.results ?? []).slice(0, count).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content ?? '',
    }))
  },
}

// DuckDuckGo's HTML endpoint wraps each result URL in a redirect
// (//duckduckgo.com/l/?uddg=<encoded>); pull the real target back out.
function ddgRealUrl(href: string): string {
  try {
    return new URL(href, 'https://duckduckgo.com').searchParams.get('uddg') ?? href
  } catch {
    return href
  }
}

// No key, no config — the always-available fallback. Scrapes the HTML results
// page, so it's the most fragile; fine for local/dev, not for production load.
const ddgProvider: SearchProvider = {
  name: 'duckduckgo',
  isAvailable: () => true,
  async search(query, count) {
    const u = new URL('https://html.duckduckgo.com/html/')
    u.searchParams.set('q', query)
    const res = await fetch(u, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT },
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const doc = new JSDOM(await res.text()).window.document
    const out: SearchResult[] = []
    for (const el of Array.from(doc.querySelectorAll('.result'))) {
      const a = el.querySelector('a.result__a')
      if (!a) continue
      out.push({
        title: a.textContent?.trim() ?? '',
        url: ddgRealUrl(a.getAttribute('href') ?? ''),
        snippet: el.querySelector('.result__snippet')?.textContent?.trim() ?? '',
      })
      if (out.length >= count) break
    }
    return out
  },
}

// Precedence for auto-detection: keyed providers first (better quality), DDG
// last as the always-on fallback.
const SEARCH_PROVIDERS: SearchProvider[] = [tavilyProvider, braveProvider, searxngProvider, ddgProvider]

// An explicit provider wins (even if its key is missing — the search() call
// then errors clearly). 'auto' picks the first available provider; DDG always
// qualifies.
export function pickSearchProvider(cfg: ResolvedSearchConfig): SearchProvider {
  if (cfg.provider !== 'auto') {
    const chosen = SEARCH_PROVIDERS.find((p) => p.name === cfg.provider)
    if (chosen) return chosen
  }
  return SEARCH_PROVIDERS.find((p) => p.isAvailable(cfg)) ?? ddgProvider
}

function formatResults(results: SearchResult[]): string {
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n')
}

const SearchParams = Type.Object({
  query: Type.String({ description: 'The search query.' }),
  count: Type.Optional(
    Type.Number({ description: `Max results to return (1-${MAX_COUNT}, default ${DEFAULT_COUNT}).` })
  ),
})

// `getConfig` is read per call (not snapshotted) so a config change in Settings
// takes effect on the next search without re-registering the tool.
export function webSearchSpec(getConfig: () => WebSearchInjection): ToolSpec {
  return {
    group: 'web',
    name: 'web_search',
    risk: 'low', // read-only result list; nothing is opened or changed
    source: 'builtin',
    build: (_ctx: ToolRunContext): AgentTool => ({
      name: 'web_search',
      label: 'Web Search',
      description:
        'Search the web and return a ranked list of {title, url, snippet}. ' +
        'Use it to discover URLs, then call fetch to read a page in full.',
      parameters: SearchParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { query?: string; count?: number }
        const query = (p.query ?? '').trim()
        if (!query) return err('empty query')
        const count = Math.min(Math.max(p.count ?? DEFAULT_COUNT, 1), MAX_COUNT)
        const cfg = resolveSearchConfig(getConfig())
        const provider = pickSearchProvider(cfg)
        try {
          const results = await provider.search(query, count, cfg)
          if (results.length === 0) return ok('(no results)', { provider: provider.name, query })
          return ok(formatResults(results), { provider: provider.name, query, count: results.length })
        } catch (e) {
          const msg =
            e instanceof Error && e.name === 'TimeoutError'
              ? `timed out after ${SEARCH_TIMEOUT_MS}ms`
              : e instanceof Error
                ? e.message
                : String(e)
          return err(`${provider.name}: ${msg}`)
        }
      },
    }),
  }
}
