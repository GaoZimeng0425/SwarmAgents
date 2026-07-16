// apps/desktop/src/renderer/src/lib/workspace/build-artifacts.ts
// Pure builder for the workspace artifacts tab. v3: the session-extracted file
// outputs were derived from v2 message.* tool_call events; on the entry rails no
// messages are fed in, so only cwd-scanned artifacts (a live feature) populate the
// tab. Re-deriving session outputs from entries is P2+ (see task-9 report).

import type { MessageRecord } from '@shared/lib/apply-event'
import type { ArtifactEntry } from '@swarm/protocol'

export type ArtifactRow = {
  id: string
  name: string
  /** Filesystem path (file) or bvid (bilibili). Passed to openPath/bilibili.open. */
  ref: string
  /** 'session' for extracted outputs, or the 'Bilibili' label for analyses. */
  origin: string
  modifiedAt?: number
}

/** cwd-scanned artifacts only; session-extracted outputs are not rebuilt yet (P2+). */
export function buildArtifacts(
  _messages: MessageRecord[],
  cwdArtifacts: ArtifactEntry[],
  _cwd?: string
): ArtifactRow[] {
  return cwdArtifacts.map((a) => ({
    id: `bilibili:${a.ref}`,
    name: a.name,
    ref: a.ref,
    origin: a.origin,
    modifiedAt: a.modifiedAt,
  }))
}
