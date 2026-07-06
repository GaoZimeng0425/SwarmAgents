// Plain-JSON cache of "soft-deleted" videos keyed by bvid. When a user removes
// a video from Bilibili (un-fav / clear watch-later) but wants to keep the card
// locally, the row lands here. Not encrypted: video metadata is not a secret.
// Loads the whole map into memory on first access; writes are atomic
// (tmp -> rename). A malformed file loads as empty so a bad write never wedges
// the feature. Mirrors analysis-store.ts.
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import { type BiliVideo, BiliVideoSchema } from '@swarm/protocol'
import { z } from 'zod'

export type ArchiveStore = {
  list(): BiliVideo[]
  put(video: BiliVideo): Promise<void>
  remove(bvid: string): Promise<void>
  has(bvid: string): boolean
}

const MapSchema = z.record(z.string(), BiliVideoSchema)

export function createArchiveStore(opts: { filePath: string }): ArchiveStore {
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
