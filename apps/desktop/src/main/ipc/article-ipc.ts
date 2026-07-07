import { createLogger } from '@shared/logger'
import type { AnalyzeArticleResult, ServiceClient } from '@swarm/protocol'
import { ipcMain } from 'electron'

import type { Service as ProvidersService } from '../providers'

const log = createLogger({ process: 'main' }).child({ component: 'article-ipc' })

export function wireArticleIpc(args: { serviceClient: ServiceClient; providers: ProvidersService }): {
  dispose: () => void
} {
  const { serviceClient, providers } = args

  // analyze host-injects the active provider before forwarding to the service,
  // mirroring swarm-ipc.ts's analyzeEmail block. collectArticle is intentionally
  // NOT registered here — it is WS-only (extension→service).
  const analyzeArticle = async (_e: unknown, articleId: string): Promise<AnalyzeArticleResult> => {
    const injection = providers.getInjection()
    if (!injection) {
      log.warn({ msg: 'analyze article without provider', articleId })
      return { ok: false, code: 'no_provider', message: '请先在 设置 → 模型 配置提供商。' }
    }
    log.info({ msg: 'analyze article dispatched', articleId, providerId: injection.id })
    return serviceClient.analyzeArticle({ articleId, provider: injection })
  }

  ipcMain.handle('swarm:article:list', () => serviceClient.listArticles())
  ipcMain.handle('swarm:article:analyze', analyzeArticle)
  ipcMain.handle('swarm:article:getAnalysis', (_e, id: string) => serviceClient.getArticleAnalysis(id))
  ipcMain.handle('swarm:article:delete', (_e, id: string) => serviceClient.deleteArticle(id))

  return {
    dispose: () => {
      ipcMain.removeHandler('swarm:article:list')
      ipcMain.removeHandler('swarm:article:analyze')
      ipcMain.removeHandler('swarm:article:getAnalysis')
      ipcMain.removeHandler('swarm:article:delete')
    },
  }
}
