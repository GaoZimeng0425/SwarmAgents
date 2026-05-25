// src/main/providers/test-connection.ts
//
// Provider-side health check. Fires a 1-token request against the provider's
// canonical chat endpoint and maps HTTP status to a structured result. Used
// by the Settings "Test" button.
import type { ProviderInjection } from '@shared/types/provider'

export type TestResult =
  | { ok: true; latencyMs: number }
  | {
      ok: false
      code: 'no_key' | 'unauthorized' | 'rate_limited' | 'network' | 'unknown'
      message: string
    }

const TIMEOUT_MS = 10_000
const ANTHROPIC_VERSION = '2023-06-01'

export async function testConnection(p: ProviderInjection): Promise<TestResult> {
  if (!p.apiKey) return { ok: false, code: 'no_key', message: 'no API key' }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  const started = Date.now()

  try {
    const res =
      p.id === 'anthropic'
        ? await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            signal: ac.signal,
            headers: {
              'content-type': 'application/json',
              'x-api-key': p.apiKey,
              'anthropic-version': ANTHROPIC_VERSION,
            },
            body: JSON.stringify({
              model: p.model,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
          })
        : await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            signal: ac.signal,
            headers: {
              'content-type': 'application/json',
              Authorization: `Bearer ${p.apiKey}`,
            },
            body: JSON.stringify({
              model: p.model,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
          })

    const latencyMs = Date.now() - started
    if (res.ok) return { ok: true, latencyMs }
    if (res.status === 401 || res.status === 403)
      return { ok: false, code: 'unauthorized', message: `HTTP ${res.status}` }
    if (res.status === 429) return { ok: false, code: 'rate_limited', message: 'HTTP 429' }
    return { ok: false, code: 'unknown', message: `HTTP ${res.status}` }
  } catch (e) {
    return {
      ok: false,
      code: 'network',
      message: e instanceof Error ? e.message : String(e),
    }
  } finally {
    clearTimeout(timer)
  }
}
