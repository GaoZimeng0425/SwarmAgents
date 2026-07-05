// Observable-artifact index for the command palette's `/` 文件 & 产出 scope.
// Aggregates two sources in the MAIN process (filesystem access + bilibili
// analyses): cwd-recent-files and saved Bilibili summaries. Composer
// attachments are deferred (cross-process join not worth it for 3a).
//
// Pure-ish: filesystem-scanning is a side effect, but the bilibili source is
// injected so tests can stub it. cwd scan caps depth at 3, skips node_modules /
// .git / dotfiles, and filters to files modified within the last 14 days.

import { readdir, stat } from 'node:fs/promises'
import type { ArtifactEntry } from '@swarm/protocol'

const MAX_DEPTH = 3
const MAX_AGE_MS = 14 * 86_400_000
const DEFAULT_LIMIT = 50

export type BilibiliArtifact = { bvid: string; title: string; origin: string }
export type BilibiliSource = () => Promise<BilibiliArtifact[]>

type ListOpts = {
  cwd: string
  bilibiliSource: BilibiliSource
  query?: string
  limit?: number
}

export async function listArtifacts(opts: ListOpts): Promise<ArtifactEntry[]> {
  const now = Date.now()
  const limit = opts.limit ?? DEFAULT_LIMIT

  const [files, bilibili] = await Promise.all([scanCwd(opts.cwd, now), opts.bilibiliSource().catch(() => [])])

  const entries: ArtifactEntry[] = [
    ...files.map((f) => ({
      kind: 'file' as const,
      name: f.name,
      ref: f.path,
      size: f.size,
      modifiedAt: f.mtime,
      origin: opts.cwd,
    })),
    ...bilibili.map((b) => ({
      kind: 'bilibili-analysis' as const,
      name: b.title,
      ref: b.bvid,
      origin: b.origin,
    })),
  ]

  const filtered = opts.query
    ? entries.filter((e) => `${e.name} ${e.origin}`.toLowerCase().includes(opts.query!.toLowerCase()))
    : entries

  // Files are already mtime-desc from scanCwd; bilibili appended after. Preserve
  // that order (recent files first), then truncate.
  return filtered.slice(0, limit)
}

type ScannedFile = { name: string; path: string; size: number; mtime: number }

async function scanCwd(cwd: string, now: number): Promise<ScannedFile[]> {
  const out: ScannedFile[] = []
  const skip = new Set(['node_modules', '.git', '.next', '.cache', 'dist', 'build'])

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable dir — skip silently
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue
        await walk(full, depth + 1)
      } else if (entry.isFile()) {
        let s: import('node:fs').Stats
        try {
          s = await stat(full)
        } catch {
          continue
        }
        if (now - s.mtimeMs > MAX_AGE_MS) continue
        out.push({ name: entry.name, path: full, size: s.size, mtime: s.mtimeMs })
      }
    }
  }

  await walk(cwd, 1)
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}
