import { Readability } from '@mozilla/readability'
import { ArticleSource } from '@swarm/protocol'
import TurndownService from 'turndown'

// Pure extractor: takes a Document + Location (both injectable for tests via jsdom)
// and returns a cleaned ArticleSource, or null if the page is not an article.
// Readability is lenient and will happily "extract" near-empty pages (e.g. a
// lone "<p>hi</p>"), yielding an empty title. We validate the candidate against
// the ArticleSource schema so such non-articles are rejected (title min length,
// content length bounds) rather than producing an invalid payload downstream.
export function extractArticleFromDocument(doc: Document, loc: Location): ArticleSource | null {
  try {
    const clone = doc.cloneNode(true) as Document
    const article = new Readability(clone).parse()
    if (!article?.content) return null
    const candidate: ArticleSource = {
      url: loc.href,
      title: article.title ?? doc.title,
      author: article.byline ?? null,
      siteName: article.siteName ?? null,
      publishedTime: null,
      contentMarkdown: new TurndownService().turndown(article.content),
    }
    const parsed = ArticleSource.safeParse(candidate)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
