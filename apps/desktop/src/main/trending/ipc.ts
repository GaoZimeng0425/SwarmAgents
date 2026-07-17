// src/main/trending/ipc.ts
//
// Wires the trending subsystem to Electron IPC. `trending:get` is a dep-free
// read endpoint (fetches live from OSSInsight). The research endpoints need the
// serviceClient + providers, so they live in a separate wiring called once those
// are up (mirrors article-ipc.ts).
import { createLogger } from '@shared/logger'
import type { ResearchRepoResult, ServiceClient } from '@swarm/protocol'
import { TRENDING_PERIODS, type TrendingPeriod, type TrendingRepo } from '@swarm/protocol'

import { createIpcRegistrar } from '../ipc/wire'
import type { Service as ProvidersService } from '../providers'
import { fetchTrending } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'trending-ipc' })

function asPeriod(v: unknown): TrendingPeriod {
  return TRENDING_PERIODS.includes(v as TrendingPeriod) ? (v as TrendingPeriod) : 'past_24_hours'
}

export function wireTrendingIpc(): { dispose: () => void } {
  const ipc = createIpcRegistrar()

  ipc.handle('trending:get', (_e: Electron.IpcMainInvokeEvent, period: TrendingPeriod, language: string) => {
    // The table types these as TrendingPeriod/string, but the renderer bridge
    // is the only enforcement point — a compromised renderer could still send
    // anything over the wire, so the coercion guard stays.
    const p = asPeriod(period)
    const lang = typeof language === 'string' && language.length > 0 ? language : 'All'
    if (p !== period || lang !== language) {
      log.warn({
        msg: 'trending params coerced to defaults',
        period,
        language,
        resolvedPeriod: p,
        resolvedLanguage: lang,
      })
    }
    return fetchTrending(p, lang)
  })

  log.info({ msg: 'trending IPC wired' })

  return {
    dispose(): void {
      ipc.dispose()
    },
  }
}

// Research endpoints: renderer→main→service. `research` host-injects the active
// provider before forwarding (mirrors article-ipc.ts's analyzeArticle). The
// repo is client-supplied (the list is fetched live, never persisted).
export function wireTrendingResearchIpc(args: { serviceClient: ServiceClient; providers: ProvidersService }): {
  dispose: () => void
} {
  const { serviceClient, providers } = args
  const ipc = createIpcRegistrar()

  const research = async (
    _e: Electron.IpcMainInvokeEvent,
    repo: TrendingRepo,
    period: TrendingPeriod
  ): Promise<ResearchRepoResult> => {
    const injection = providers.getInjection()
    if (!injection) {
      log.warn({ msg: 'research repo without provider', repoName: repo.repoName })
      return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    }
    const p = asPeriod(period)
    log.info({ msg: 'research repo dispatched', repoName: repo.repoName, period: p, providerId: injection.id })
    return serviceClient.researchRepo({ repo, period: p, provider: injection })
  }

  ipc.handle('trending:research', research)
  ipc.handle('trending:getResearch', (_e, repoName: string) => serviceClient.getRepoResearch(repoName))
  ipc.handle('trending:researchedNames', () => serviceClient.researchedRepoNames())

  return {
    dispose(): void {
      ipc.dispose()
    },
  }
}
