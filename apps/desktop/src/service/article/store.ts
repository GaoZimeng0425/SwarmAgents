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
  // Internal persistence field: a per-store in-memory monotonic sequence counter
  // used as a strict insertion-order tiebreaker for list() when two adds share
  // the same collectedAt millisecond. NOT part of the public CollectedArticle shape.
  seq: z.number().int().nonnegative(),
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
  // Per-store monotonic sequence counter: strict insertion-order tiebreaker for
  // list() when two adds share the same collectedAt millisecond. Unlike ulid
  // (non-monotonic across ms ticks), this counter is assigned synchronously and
  // deterministically within a single store instance.
  let seq = 0

  load()

  function load(): void {
    try {
      const raw = readFileSync(file, 'utf8')
      const parsed = FileSchema.safeParse(JSON.parse(raw))
      if (parsed.success) {
        // Object.entries preserves insertion order for non-integer-like string
        // keys, so assigning seq in iteration order best-effort reconstructs
        // original insertion order for the tiebreaker. Original insertion order
        // cannot be known exactly, but this is stable and monotonic. After this
        // loop, seq is past every loaded record, so subsequent add()s continue
        // monotonically.
        const map = new Map<string, ArticleRecord>()
        for (const [id, record] of Object.entries(parsed.data)) {
          map.set(id, { ...record, seq: seq++ })
        }
        cache = map
      } else {
        log.warn({ msg: 'article store parse failed, starting empty' })
      }
    } catch {
      // first run — file does not exist yet
    }
  }

  function persist(): void {
    // The fs write itself is synchronous (writeFileSync + renameSync), so the
    // single-flight guarantee is structural: blocking sync fs calls cannot
    // overlap. Executing the write inline (not deferred to a microtask) lets
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
    const { summary, analyzedAt, seq, ...rest } = r
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
        seq: seq++,
        summary: null,
        analyzedAt: null,
      }
      cache.set(id, record)
      persist()
      const { summary, analyzedAt, seq: _seq, ...publicFields } = record
      return publicFields
    },
    list() {
      return [...cache.values()]
        .sort((a, b) => {
          // Newest-first by collectedAt; the per-store seq counter breaks ties
          // when two adds land in the same millisecond, giving strict reverse
          // insertion order deterministically (unlike ulid, which is
          // non-monotonic across ms ticks).
          return b.collectedAt.localeCompare(a.collectedAt) || b.seq - a.seq
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
