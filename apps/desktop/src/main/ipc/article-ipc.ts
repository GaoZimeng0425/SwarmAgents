import { createLogger } from '@shared/logger'
import type { AnalyzeArticleResult, ServiceClient } from '@swarm/protocol'

import type { Service as ProvidersService } from '../providers'
import { createIpcRegistrar } from './wire'

const log = createLogger({ process: 'main' }).child({ component: 'article-ipc' })

export function wireArticleIpc(args: { serviceClient: ServiceClient; providers: ProvidersService }): {
  dispose: () => void
} {
  const { serviceClient, providers } = args
  const ipc = createIpcRegistrar()

  // analyze host-injects the active provider before forwarding to the service,
  // mirroring swarm-ipc.ts's analyzeEmail block. collectArticle is intentionally
  // NOT registered here — it is WS-only (extension→service).
  const analyzeArticle = async (_e: Electron.IpcMainInvokeEvent, articleId: string): Promise<AnalyzeArticleResult> => {
    const injection = providers.getInjection()
    if (!injection) {
      log.warn({ msg: 'analyze article without provider', articleId })
      return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    }
    log.info({ msg: 'analyze article dispatched', articleId, providerId: injection.id })
    return serviceClient.analyzeArticle({ articleId, provider: injection })
  }

  ipc.handle('swarm:article:list', () => serviceClient.listArticles())
  ipc.handle('swarm:article:analyze', analyzeArticle)
  ipc.handle('swarm:article:getAnalysis', (_e, id: string) => serviceClient.getArticleAnalysis(id))
  ipc.handle('swarm:article:delete', (_e, id: string) => serviceClient.deleteArticle(id))

  return {
    dispose: () => {
      ipc.dispose()
    },
  }
}
