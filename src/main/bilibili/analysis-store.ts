// Plain-JSON cache of AI analyses keyed by bvid (summary + full text + source).
// Not encrypted: unlike credentials in store.ts, summaries/transcripts are not
// secrets. Loads the whole map into memory on first access; writes are atomic
// (tmp -> rename). A malformed file loads as empty so a bad write never wedges
// the feature.
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import { type BiliAnalysis, BiliAnalysisSchema } from '@shared/types/bilibili'
import { z } from 'zod'

export type AnalysisStore = {
  get(bvid: string): BiliAnalysis | null
  put(a: BiliAnalysis): Promise<void>
  bvids(): string[]
}

const MapSchema = z.record(z.string(), BiliAnalysisSchema)

export function createAnalysisStore(opts: { filePath: string }): AnalysisStore {
  const { filePath } = opts

  const load = (): Record<string, BiliAnalysis> => {
    if (!existsSync(filePath)) return {}
    try {
      const parsed = MapSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')))
      return parsed.success ? parsed.data : {}
    } catch {
      return {}
    }
  }

  const map = load()

  let saveQueue: Promise<void> = Promise.resolve()
  const persist = (): Promise<void> => {
    const next = saveQueue.then(async () => {
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, JSON.stringify(map))
      await fs.rename(tmp, filePath)
    })
    saveQueue = next.catch(() => undefined)
    return next
  }

  return {
    get: (bvid) => map[bvid] ?? null,
    put: (a) => {
      map[a.bvid] = a
      return persist()
    },
    bvids: () => Object.keys(map),
  }
}
