import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchTrending } from './service'

// biome-ignore lint/style/useNamingConvention: API response shape from OSSInsight
const apiBody = {
  type: 'sql_endpoint',
  data: {
    columns: [],
    rows: [
      {
        repo_id: '1',
        repo_name: 'owner/repo',
        description: 'a cool repo',
        language: 'Rust',
        stars: '123',
        forks: '45',
        pull_requests: '6',
        pushes: '7',
        total_score: '99.5',
        contributor_logins: 'alice,bob',
        collection_names: '',
      },
    ],
    result: {},
  },
}

function mockFetchOnce(body: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      json: async () => body,
    }))
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('fetchTrending', () => {
  it('maps snake_case rows to camelCase TrendingRepo with numeric fields', async () => {
    mockFetchOnce(apiBody)
    const repos = await fetchTrending('past_week', 'Rust')
    expect(repos).toHaveLength(1)
    expect(repos[0]).toEqual({
      repoName: 'owner/repo',
      description: 'a cool repo',
      language: 'Rust',
      stars: 123,
      forks: 45,
      pullRequests: 6,
      totalScore: 99.5,
      contributorLogins: 'alice,bob',
    })
  })

  it('caches by (period, language) within the TTL — second call does not re-fetch', async () => {
    mockFetchOnce(apiBody)
    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    await fetchTrending('past_month', 'Go')
    await fetchTrending('past_month', 'Go')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('re-fetches after the cache TTL expires', async () => {
    vi.useFakeTimers()
    mockFetchOnce(apiBody)
    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    await fetchTrending('past_3_months', 'Python')
    vi.advanceTimersByTime(61 * 60 * 1000) // > 1h
    await fetchTrending('past_3_months', 'Python')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('throws on a non-2xx response', async () => {
    mockFetchOnce({}, false, 500)
    await expect(fetchTrending('past_24_hours', 'Java')).rejects.toThrow(/500/)
  })

  it('propagates an abort/timeout rejection', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw abortError
      })
    )
    await expect(fetchTrending('past_week', 'TypeScript')).rejects.toThrow('aborted')
  })
})
