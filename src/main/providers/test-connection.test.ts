import { afterEach, describe, expect, it, vi } from 'vitest'

import { testConnection } from './test-connection'

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
})

describe('testConnection', () => {
  it('returns ok:true and latencyMs for HTTP 200', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    const r = await testConnection({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('maps HTTP 401 to unauthorized', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 401 }))
    const r = await testConnection({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk' })
    expect(r).toMatchObject({ ok: false, code: 'unauthorized' })
  })

  it('maps HTTP 403 to unauthorized', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 403 }))
    const r = await testConnection({ id: 'openai', model: 'gpt-4o', apiKey: 'sk' })
    expect(r).toMatchObject({ ok: false, code: 'unauthorized' })
  })

  it('maps HTTP 429 to rate_limited', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 429 }))
    const r = await testConnection({ id: 'openai', model: 'gpt-4o', apiKey: 'sk' })
    expect(r).toMatchObject({ ok: false, code: 'rate_limited' })
  })

  it('maps other non-2xx to unknown with status code in message', async () => {
    global.fetch = vi.fn(async () => new Response('boom', { status: 503 }))
    const r = await testConnection({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('unknown')
      expect(r.message).toContain('503')
    }
  })

  it('maps fetch throw / timeout to network', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const r = await testConnection({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk' })
    expect(r).toMatchObject({ ok: false, code: 'network' })
  })

  it('targets Anthropic /v1/messages with the model + key', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    global.fetch = f
    await testConnection({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-anth' })
    const [url, init] = f.mock.calls[0]
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-anth')
    expect(headers['anthropic-version']).toBeDefined()
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.model).toBe('claude-sonnet-4-5')
    expect(body.max_tokens).toBe(1)
  })

  it('targets OpenAI /v1/chat/completions with Bearer token', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    global.fetch = f
    await testConnection({ id: 'openai', model: 'gpt-4o', apiKey: 'sk-openai' })
    const [url, init] = f.mock.calls[0]
    expect(String(url)).toBe('https://api.openai.com/v1/chat/completions')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-openai')
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.model).toBe('gpt-4o')
    expect(body.max_tokens).toBe(1)
  })
})
