// Fetches GitHub trending repos from OSSInsight's public REST API and caches
// results in memory per (period, language). OSSInsight refreshes the data daily,
// so a 1h client cache is plenty and keeps the API friendly.
import { createLogger } from '@shared/logger'
import type { TrendingPeriod, TrendingRepo } from '@swarm/protocol'

const log = createLogger({ process: 'main' }).child({ component: 'trending' })

const API_BASE = 'https://api.ossinsight.io/v1/trends/repos/'
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

type CacheEntry = { at: number; repos: TrendingRepo[] }
const cache = new Map<string, CacheEntry>()

type ApiRow = Record<string, string | null>
type ApiResponse = { data?: { rows?: ApiRow[] } }

function toRepo(row: ApiRow): TrendingRepo {
  return {
    repoName: row.repo_name ?? '',
    description: row.description ?? '',
    language: row.language ?? '',
    stars: Number(row.stars) || 0,
    forks: Number(row.forks) || 0,
    pullRequests: Number(row.pull_requests) || 0,
    totalScore: Number(row.total_score) || 0,
    contributorLogins: row.contributor_logins ?? '',
  }
}

export async function fetchTrending(period: TrendingPeriod, language: string): Promise<TrendingRepo[]> {
  const key = `${period}|${language}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    log.debug({ msg: 'trending cache hit', period, language })
    return cached.repos
  }

  const url = `${API_BASE}?period=${encodeURIComponent(period)}&language=${encodeURIComponent(language)}`
  const startedAt = Date.now()
  log.info({ msg: 'trending fetch started', period, language })
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`OSSInsight API ${res.status} ${res.statusText}`)
    const body = (await res.json()) as ApiResponse
    const rows = body.data?.rows ?? []
    if (rows.length === 0) log.warn({ msg: 'trending returned no rows', period, language })
    const repos = rows.map(toRepo)
    cache.set(key, { at: Date.now(), repos })
    log.info({ msg: 'trending fetch ok', period, language, count: repos.length, durationMs: Date.now() - startedAt })
    return repos
  } catch (err) {
    log.error({
      msg: 'trending fetch failed',
      err: err instanceof Error ? err.message : String(err),
      period,
      language,
    })
    throw err
  }
}
