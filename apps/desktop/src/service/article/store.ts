import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '@shared/logger'
import type { ArticleSource, ArticleSummary, CollectedArticle, CollectedArticleWithAnalysis } from '@swarm/protocol'
import { ulid } from 'ulid'
import { z } from 'zod'

const log = createLogger({ process: 'service' }).child({ component: 'article-store' })

const ArticleRecordSchema = z.object({
  url: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  siteName: z.string().nullable(),
  publishedTime: z.string().nullable(),
  contentMarkdown: z.string(),
  id: z.string(),
  collectedAt: z.string(),
  excerpt: z.string(),
  summary: z
    .object({
      gist: z.string(),
      points: z.array(z.string()),
      takeaways: z.array(z.string()),
    })
    .nullable(),
  analyzedAt: z.string().nullable(),
})

type ArticleRecord = z.infer<typeof ArticleRecordSchema>

const FileSchema = z.record(z.string(), ArticleRecordSchema)

export type ArticleStore = {
  add(input: ArticleSource): CollectedArticle
  list(): CollectedArticleWithAnalysis[]
  get(id: string): ArticleRecord | null
  saveAnalysis(id: string, summary: ArticleSummary): void
  delete(id: string): void
}

export function createArticleStore(deps: { userDataDir: string }): ArticleStore {
  const file = join(deps.userDataDir, 'collected-articles.json')
  let cache = new Map<string, ArticleRecord>()

  load()

  function load(): void {
    try {
      const raw = readFileSync(file, 'utf8')
      const parsed = FileSchema.safeParse(JSON.parse(raw))
      if (parsed.success) {
        cache = new Map(Object.entries(parsed.data))
      } else {
        log.warn({ msg: 'article store parse failed, starting empty' })
      }
    } catch {
      // first run — file does not exist yet
    }
  }

  function persist(): void {
    // The fs write itself is synchronous (writeFileSync + renameSync), so the
    // single-flight guarantee is structural: writes cannot overlap. saveQueue is
    // a resolved promise kept for ordering/error aggregation if this ever moves
    // to async fs. Executing the write inline (not deferred to a microtask) lets
    // callers observe the persisted file synchronously after a mutation.
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(cache), null, 2))
      renameSync(tmp, file)
    } catch (err) {
      log.error({ msg: 'article store write failed', err: err instanceof Error ? err.message : String(err) })
    }
  }

  function toPublic(r: ArticleRecord): CollectedArticleWithAnalysis {
    const { summary, analyzedAt, ...rest } = r
    return { ...rest, summary: summary ?? null, analyzedAt: analyzedAt ?? null }
  }

  return {
    add(input) {
      const id = ulid()
      const now = new Date().toISOString()
      const record: ArticleRecord = {
        ...input,
        id,
        collectedAt: now,
        excerpt: input.contentMarkdown.slice(0, 300),
        summary: null,
        analyzedAt: null,
      }
      cache.set(id, record)
      persist()
      const { summary, analyzedAt, ...publicFields } = record
      return publicFields
    },
    list() {
      return [...cache.values()]
        .sort((a, b) => {
          // Newest-first by collectedAt; ulid (monotonic, time-prefixed) breaks
          // ties when two adds land in the same millisecond.
          const byTime = b.collectedAt.localeCompare(a.collectedAt)
          return byTime !== 0 ? byTime : b.id.localeCompare(a.id)
        })
        .map(toPublic)
    },
    get(id) {
      return cache.get(id) ?? null
    },
    saveAnalysis(id, summary) {
      const r = cache.get(id)
      if (!r) return
      cache.set(id, { ...r, summary, analyzedAt: new Date().toISOString() })
      persist()
    },
    delete(id) {
      if (cache.delete(id)) persist()
    },
  }
}
