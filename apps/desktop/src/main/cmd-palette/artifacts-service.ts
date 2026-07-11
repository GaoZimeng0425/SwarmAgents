// Observable-artifact index for the command palette's `/` 产出 scope.
// Aggregates saved Bilibili summaries in the MAIN process. The bilibili
// source is injected so tests can stub it.

import type { ArtifactEntry } from '@swarm/protocol'

const DEFAULT_LIMIT = 50

export type BilibiliArtifact = { bvid: string; title: string; origin: string }
export type BilibiliSource = () => Promise<BilibiliArtifact[]>

type ListOpts = {
  bilibiliSource: BilibiliSource
  query?: string
  limit?: number
}

export async function listArtifacts(opts: ListOpts): Promise<ArtifactEntry[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT
  const bilibili = await opts.bilibiliSource().catch(() => [])

  const entries: ArtifactEntry[] = bilibili.map((b) => ({
    kind: 'bilibili-analysis' as const,
    name: b.title,
    ref: b.bvid,
    origin: b.origin,
  }))

  const filtered = opts.query
    ? entries.filter((e) => `${e.name} ${e.origin}`.toLowerCase().includes(opts.query!.toLowerCase()))
    : entries

  return filtered.slice(0, limit)
}
