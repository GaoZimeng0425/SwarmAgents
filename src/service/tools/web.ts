import { Readability } from '@mozilla/readability'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
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

const IPV4_PRIVATE =
  /^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|172\.(1[6-9]|2\d|3[01])\.)/

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
