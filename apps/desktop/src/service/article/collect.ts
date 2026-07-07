import { createLogger } from '@shared/logger'
import { ArticleSource, type CollectArticleResult } from '@swarm/protocol'

import type { ArticleStore } from './store'

const log = createLogger({ process: 'service' }).child({ component: 'article-collect' })

export function createCollectArticle(deps: { store: ArticleStore }) {
  return (input: unknown): CollectArticleResult => {
    const parsed = ArticleSource.safeParse(input)
    if (!parsed.success) {
      log.warn({ msg: 'article rejected', reason: parsed.error.message })
      return { ok: false, code: 'invalid', message: parsed.error.message }
    }
    const article = deps.store.add(parsed.data)
    log.info({ msg: 'article collected', articleId: article.id, url: article.url, titleLen: article.title.length })
    return { ok: true, articleId: article.id }
  }
}
