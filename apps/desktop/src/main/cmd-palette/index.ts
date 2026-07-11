// Main-process wiring for the command-palette backend. Owns the artifacts
// service (bilibili) and exposes a handle the IPC layer calls into.
// The bilibili source is injected so it can read the same analysis store the
// bilibili subsystem writes to, without coupling to its internals.

import type { ArtifactEntry } from '@swarm/protocol'

import { type BilibiliArtifact, type BilibiliSource, listArtifacts } from './artifacts-service'

export type CmdPaletteHandle = {
  /** Returns artifacts matching the optional query (bilibili analyses). */
  listArtifacts(opts: { query?: string; limit?: number }): Promise<ArtifactEntry[]>
}

export function initCmdPaletteArtifacts(opts: { bilibiliSource: BilibiliSource }): CmdPaletteHandle {
  return {
    async listArtifacts({ query, limit }) {
      return listArtifacts({ bilibiliSource: opts.bilibiliSource, query, limit })
    },
  }
}

// Helper for callers that have bilibili analyses but not in the ArtifactEntry
// shape — converts the analysis-store output to BilibiliArtifact[]. Falls back
// to the bvid as the title when no title is stored (BiliAnalysis has no title
// field, so this is the common path until video metadata is joined in).
export function toBilibiliArtifacts(analyses: Array<{ bvid: string; title?: string | null }>): BilibiliArtifact[] {
  return analyses.map((a) => ({ bvid: a.bvid, title: a.title ?? a.bvid, origin: 'Bilibili' }))
}
