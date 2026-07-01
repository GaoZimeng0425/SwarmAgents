// src/main/providers/test-connection.ts
//
// Provider-side health check. Fires a 1-token request against the provider's
// canonical chat endpoint and maps HTTP status to a structured result. Used
// by the Settings "Test" button.
import type { ProviderInjection } from '@swarm/protocol'

export type TestResult =
  | { ok: true; latencyMs: number; url: string }
  | {
      ok: false
      code: 'no_key' | 'unauthorized' | 'rate_limited' | 'network' | 'unknown'
      message: string
      /** The URL the request was sent to (undefined when we never got that far). */
      url?: string
    }

const TIMEOUT_MS = 10_000
const ANTHROPIC_VERSION = '2023-06-01'

// Default baseUrls match pi-ai's built-in model.baseUrl values so test-connection
// and runtime go through the same URL composition. OpenAI vendors include the
// version root (e.g. `/v1`, BigModel's `/v4`) in baseUrl; we append only the
// endpoint path. Anthropic SDK appends `/v1/messages` itself at runtime, so
// for testing we mimic that by appending `/v1/messages` to the host root.
const DEFAULT_BASE_URL = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
} as const

const PATH_BY_STYLE = {
  anthropic: '/v1/messages',
  openai: '/chat/completions',
} as const

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/**
 * OpenAI / Anthropic / most OpenAI-compatible vendors all return errors as
 * `{ error: { message: "..." } }` or just `{ message: "..." }`. Pull out a
 * short, human-readable string when possible — without it, "HTTP 404" tells
 * the user nothing about whether the URL is wrong, the model is wrong, or
 * the key isn't entitled.
 */
async function extractServerMessage(res: Response): Promise<string | null> {
  let text: string
  try {
    text = await res.text()
  } catch {
    return null
  }
  if (!text) return null
  try {
    const json = JSON.parse(text)
    if (json && typeof json === 'object') {
      const errField = (json as { error?: unknown }).error
      if (errField && typeof errField === 'object') {
        const msg = (errField as { message?: unknown }).message
        if (typeof msg === 'string' && msg.length > 0) return msg
      }
      if (typeof errField === 'string' && errField.length > 0) return errField
      const topMsg = (json as { message?: unknown }).message
      if (typeof topMsg === 'string' && topMsg.length > 0) return topMsg
    }
  } catch {
    // not JSON — fall through to a truncated raw excerpt
  }
  const trimmed = text.trim().slice(0, 200)
  return trimmed.length > 0 ? trimmed : null
}

export async function testConnection(p: ProviderInjection): Promise<TestResult> {
  if (!p.apiKey) return { ok: false, code: 'no_key', message: 'no API key' }

  // A provider in pi-ai's registry has a default baseUrl; a custom one (no
  // registry) is known only by its wire style and needs an explicit baseUrl.
  const style = p.registry ?? p.apiStyle
  if (!p.registry && !p.baseUrl) return { ok: false, code: 'unknown', message: 'custom provider requires a Base URL' }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  const started = Date.now()
  const base = p.baseUrl ?? DEFAULT_BASE_URL[style]
  const url = joinUrl(base, PATH_BY_STYLE[style])

  try {
    const res =
      style === 'anthropic'
        ? await fetch(url, {
            method: 'POST',
            signal: ac.signal,
            headers: {
              'content-type': 'application/json',
              'x-api-key': p.apiKey,
              'anthropic-version': ANTHROPIC_VERSION,
            },
            body: JSON.stringify({
              model: p.model,
              // biome-ignore lint/style/useNamingConvention: HTTP wire format (Anthropic Messages API)
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
          })
        : await fetch(url, {
            method: 'POST',
            signal: ac.signal,
            headers: {
              'content-type': 'application/json',
              Authorization: `Bearer ${p.apiKey}`,
            },
            // `max_tokens` is the universally accepted field across OpenAI-
            // compatible vendors (DeepSeek, BigModel/Zhipu, OpenRouter, etc).
            // OpenAI's o1/o3 reasoning models prefer `max_completion_tokens`
            // and 400 on `max_tokens` — but ping-style health checks rarely
            // target reasoning models. We surface the actual server message
            // below so the user can see if they hit that edge.
            body: JSON.stringify({
              model: p.model,
              // biome-ignore lint/style/useNamingConvention: HTTP wire format (OpenAI Chat Completions)
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
          })

    const latencyMs = Date.now() - started
    if (res.ok) return { ok: true, latencyMs, url }
    const serverMsg = await extractServerMessage(res)
    const detail = serverMsg ? `HTTP ${res.status}: ${serverMsg}` : `HTTP ${res.status}`
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'unauthorized', message: detail, url }
    if (res.status === 429) return { ok: false, code: 'rate_limited', message: detail, url }
    return { ok: false, code: 'unknown', message: detail, url }
  } catch (e) {
    return {
      ok: false,
      code: 'network',
      message: e instanceof Error ? e.message : String(e),
      url,
    }
  } finally {
    clearTimeout(timer)
  }
}
