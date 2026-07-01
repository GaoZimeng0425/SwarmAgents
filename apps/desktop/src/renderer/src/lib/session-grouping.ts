import type { SessionSummary } from '@swarm/protocol'

// Sentinel key for sessions without a cwd. Their group always renders last.
export const UNGROUPED = '__UNGROUPED__'

export type DirectoryGroup = {
  // The cwd value, or the UNGROUPED sentinel.
  dir: string
  // Display label: directory basename, or '无目录' for the ungrouped bucket.
  label: string
  sessions: SessionSummary[]
}

// Within a group: pinned sessions first, then ascending manual sortOrder.
const byPinnedThenSortOrder = (a: SessionSummary, b: SessionSummary): number =>
  Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder

// Last path segment, tolerating trailing slashes and either separator.
function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

// Group non-system sessions by cwd into display-ordered directory groups:
// recorded dirs (per directoryOrder) first, then unrecorded dirs by most-recent
// session activity descending, and the ungrouped bucket always last.
export function groupSessionsByDirectory(sessions: SessionSummary[], directoryOrder: string[]): DirectoryGroup[] {
  const buckets = new Map<string, SessionSummary[]>()
  for (const s of sessions) {
    if (s.isSystem) continue
    const key = s.cwd?.trim() ? s.cwd : UNGROUPED
    const arr = buckets.get(key)
    if (arr) arr.push(s)
    else buckets.set(key, [s])
  }
  for (const arr of buckets.values()) arr.sort(byPinnedThenSortOrder)

  const known = directoryOrder.filter((d) => d !== UNGROUPED && buckets.has(d))
  const knownSet = new Set(known)
  const unknown = [...buckets.keys()].filter((d) => d !== UNGROUPED && !knownSet.has(d))
  const recencyOf = (d: string): number => (buckets.get(d) ?? []).reduce((max, s) => Math.max(max, s.lastActiveAt), 0)
  unknown.sort((a, b) => recencyOf(b) - recencyOf(a))

  const groups: DirectoryGroup[] = [...known, ...unknown].map((dir) => ({
    dir,
    label: basename(dir),
    sessions: buckets.get(dir) as SessionSummary[],
  }))
  if (buckets.has(UNGROUPED)) {
    groups.push({ dir: UNGROUPED, label: '无目录', sessions: buckets.get(UNGROUPED) as SessionSummary[] })
  }
  return groups
}

// Flatten directory groups into a single ordered id list for reorderSessions,
// preserving the visible (group × within-group) order.
export function flattenForReorder(groups: DirectoryGroup[]): string[] {
  return groups.flatMap((g) => g.sessions.map((s) => s.id))
}
