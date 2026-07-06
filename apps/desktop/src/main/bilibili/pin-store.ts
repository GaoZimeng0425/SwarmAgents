// Plain-JSON store of pinned ("favorite") videos keyed by bvid, shown in the
// Bilibili page's top bar regardless of their original source. Not encrypted.
// Loads the whole map into memory on first access; writes are atomic
// (tmp -> rename). A malformed file loads as empty so a bad write never wedges
// the feature. Mirrors analysis-store.ts.
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import { type BiliVideo, BiliVideoSchema } from '@swarm/protocol'
import { z } from 'zod'

export type PinStore = {
  list(): BiliVideo[]
  put(video: BiliVideo): Promise<void>
  remove(bvid: string): Promise<void>
  has(bvid: string): boolean
}

const MapSchema = z.record(z.string(), BiliVideoSchema)

export function createPinStore(opts: { filePath: string }): PinStore {
  const { filePath } = opts

  const load = (): Record<string, BiliVideo> => {
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
    list: () => Object.values(map),
    put: (video) => {
      map[video.bvid] = video
      return persist()
    },
    remove: (bvid) => {
      delete map[bvid]
      return persist()
    },
    has: (bvid) => Object.hasOwn(map, bvid),
  }
}
