// apps/desktop/src/renderer/src/lib/workspace/build-artifacts.ts
// Pure builder: aggregates artifacts from two sources — file paths extracted from
// the session's tool_call args (best-effort heuristic) + bilibili analyses from
// listArtifacts.

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

const PATH_LIKE = /^(\.{0,2}\/|[A-Za-z]:\\)/

function hasExtension(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? ''
  return base.includes('.')
}

function normalizePath(p: string): string {
  // Collapse /./ and trailing slashes only (lexical-only; ../ is NOT resolved —
  // a pure fn has no fs/cwd access to resolve it).
  return p.replace(/\/\.\//g, '/').replace(/\/+$/g, '')
}

/** Pull path-like strings out of a tool_call args object (values + array values). */
function extractPathsFromArgs(args: unknown): string[] {
  if (!args || typeof args !== 'object') return []
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (PATH_LIKE.test(v) && hasExtension(v)) out.push(v)
    } else if (Array.isArray(v)) {
      v.forEach(walk)
    } else if (v && typeof v === 'object') {
      for (const val of Object.values(v as Record<string, unknown>)) walk(val)
    }
  }
  walk(args)
  return out
}

/** Aggregate session-extracted file outputs + bilibili analyses, deduplicated. */
export function buildArtifacts(messages: MessageRecord[], cwdArtifacts: ArtifactEntry[]): ArtifactRow[] {
  const seen = new Set<string>()
  const sessionRows: ArtifactRow[] = []
  for (const message of messages) {
    for (const e of message.events) {
      if (e.kind !== 'message.tool_call') continue
      for (const p of extractPathsFromArgs((e as { args: unknown }).args)) {
        const norm = normalizePath(p)
        if (seen.has(norm)) continue
        seen.add(norm)
        const name = norm.split(/[\\/]/).pop() ?? norm
        sessionRows.push({ id: `session:${norm}`, name, ref: norm, origin: 'session' })
      }
    }
  }

  const cwdRows: ArtifactRow[] = cwdArtifacts.map((a) => ({
    id: `bilibili:${a.ref}`,
    name: a.name,
    ref: a.ref,
    origin: a.origin,
    modifiedAt: a.modifiedAt,
  }))

  return [...sessionRows, ...cwdRows]
}
