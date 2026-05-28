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

  it('targets OpenAI api.openai.com/v1/chat/completions with Bearer token', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    global.fetch = f
    // No baseUrl override → default `api.openai.com/v1` + `/chat/completions`.
    await testConnection({ id: 'openai', model: 'gpt-4o', apiKey: 'sk-openai' })
    const [url, init] = f.mock.calls[0]
    expect(String(url)).toBe('https://api.openai.com/v1/chat/completions')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-openai')
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.model).toBe('gpt-4o')
    // Universal `max_tokens` (works for OpenAI legacy + every OpenAI-compat vendor).
    expect(body.max_tokens).toBe(1)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('surfaces the vendor error.message body when the upstream rejects', async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: '1217', message: 'Model not found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
    )
    const r = await testConnection({
      id: 'custom',
      model: 'gpt-4o',
      apiKey: 'sk-x',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiStyle: 'openai',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('unknown')
      expect(r.message).toContain('404')
      expect(r.message).toContain('Model not found')
    }
  })

  it('surfaces a plain-text error body when not JSON', async () => {
    global.fetch = vi.fn(async () => new Response('Bad Gateway', { status: 502 }))
    const r = await testConnection({ id: 'openai', model: 'gpt-4o', apiKey: 'sk-x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('Bad Gateway')
  })

  it('uses a custom baseUrl when provided (OpenAI-compatible)', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    global.fetch = f
    // baseUrl already includes the version root (e.g. /v1, /v4) per the
    // OpenAI-SDK convention; we append only the endpoint path.
    await testConnection({
      id: 'openai',
      model: 'glm-4',
      apiKey: 'sk-x',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    })
    const [url] = f.mock.calls[0]
    expect(String(url)).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
  })

  it('uses a custom baseUrl when provided (Anthropic-compatible)', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    global.fetch = f
    await testConnection({
      id: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'sk-x',
      baseUrl: 'https://anthropic.proxy.example/api',
    })
    const [url] = f.mock.calls[0]
    expect(String(url)).toBe('https://anthropic.proxy.example/api/v1/messages')
  })

  it('custom provider with openai apiStyle posts to chat/completions', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    global.fetch = f
    await testConnection({
      id: 'custom',
      model: 'glm-4',
      apiKey: 'sk-x',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiStyle: 'openai',
    })
    const [url, init] = f.mock.calls[0]
    expect(String(url)).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-x')
  })

  it('custom provider with anthropic apiStyle posts to /v1/messages', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    global.fetch = f
    await testConnection({
      id: 'custom',
      model: 'my-claude-clone',
      apiKey: 'sk-x',
      baseUrl: 'https://anth.proxy.example',
      apiStyle: 'anthropic',
    })
    const [url, init] = f.mock.calls[0]
    expect(String(url)).toBe('https://anth.proxy.example/v1/messages')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-x')
  })

  it('custom provider without baseUrl returns a clear error', async () => {
    const r = await testConnection({
      id: 'custom',
      model: 'deepseek-chat',
      apiKey: 'sk-x',
      apiStyle: 'openai',
    })
    expect(r).toMatchObject({ ok: false, code: 'unknown' })
    if (!r.ok) expect(r.message).toContain('Base URL')
  })
})
