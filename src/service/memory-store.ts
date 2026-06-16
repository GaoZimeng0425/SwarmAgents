import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createLogger } from '@shared/logger'

const log = createLogger({ process: 'service' }).child({ component: 'memory' })

export interface MemoryEntry {
  id: string
  namespace: string
  key: string
  content: string
  category: string
  timestamp: number
}

export interface MemoryStore {
  store(namespace: string, key: string, content: string, category: string): void
  recall(query: string, limit: number, opts?: { namespace?: string; category?: string }): MemoryEntry[]
  list(namespace?: string): MemoryEntry[]
  forget(namespace: string, key: string): boolean
  close(): void
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 1)
}

function matchScore(entryTokens: Set<string>, queryTokens: string[]): number {
  let hits = 0
  for (const qt of queryTokens) {
    if (entryTokens.has(qt)) hits++
  }
  return queryTokens.length > 0 ? hits / queryTokens.length : 0
}

export function createMemoryStore(dbPath: string, onChange?: () => void): MemoryStore {
  let entries: MemoryEntry[] = []
  const insertionIndex = new Map<string, number>()
  let insertionCounter = 0

  if (existsSync(dbPath)) {
    try {
      const raw = readFileSync(dbPath, 'utf-8')
      entries = JSON.parse(raw)
    } catch {
      entries = []
    }
  }

  let dirty = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (!dirty) return
    dirty = false
    mkdirSync(dbPath.substring(0, dbPath.lastIndexOf('/')), { recursive: true })
    writeFileSync(dbPath, JSON.stringify(entries))
  }

  const scheduleFlush = (): void => {
    dirty = true
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(flush, 1000)
  }

  // Pre-compute token sets for fast matching
  const tokenSets = new Map<string, Set<string>>()
  const rebuildTokens = (entry: MemoryEntry): void => {
    tokenSets.set(entry.id, new Set(tokenize(entry.content)))
  }
  for (const e of entries) {
    rebuildTokens(e)
    insertionIndex.set(e.id, insertionCounter++)
  }

  return {
    store(namespace: string, key: string, content: string, category: string): void {
      const id = `${namespace}:${key}`
      const idx = entries.findIndex((e) => e.id === id)
      const entry: MemoryEntry = { id, namespace, key, content, category, timestamp: Date.now() }
      if (idx >= 0) {
        entries[idx] = entry
      } else {
        entries.push(entry)
      }
      insertionIndex.set(id, insertionCounter++)
      rebuildTokens(entry)
      log.debug({ msg: 'stored', namespace, key, category })
      scheduleFlush()
      onChange?.()
    },

    recall(query: string, limit: number, opts?: { namespace?: string; category?: string }): MemoryEntry[] {
      const qTokens = tokenize(query)
      const scored: Array<{ entry: MemoryEntry; score: number }> = []

      for (const entry of entries) {
        if (opts?.namespace && entry.namespace !== opts.namespace) continue
        if (opts?.category && entry.category !== opts.category) continue

        const tokens = tokenSets.get(entry.id)
        if (!tokens) continue
        const score = matchScore(tokens, qTokens)
        if (score > 0) scored.push({ entry, score })
      }

      scored.sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
      const results = scored.slice(0, limit).map((s) => s.entry)
      log.debug({ msg: 'recall', query, limit, hits: results.length })
      return results
    },

    list(namespace?: string): MemoryEntry[] {
      const filtered = namespace ? entries.filter((e) => e.namespace === namespace) : entries
      return [...filtered].sort((a, b) => {
        const tsDiff = b.timestamp - a.timestamp
        if (tsDiff !== 0) return tsDiff
        return (insertionIndex.get(b.id) ?? 0) - (insertionIndex.get(a.id) ?? 0)
      })
    },

    forget(namespace: string, key: string): boolean {
      const id = `${namespace}:${key}`
      const idx = entries.findIndex((e) => e.id === id)
      if (idx < 0) return false
      tokenSets.delete(id)
      insertionIndex.delete(id)
      entries.splice(idx, 1)
      scheduleFlush()
      onChange?.()
      return true
    },

    close(): void {
      if (flushTimer) clearTimeout(flushTimer)
      flush()
    },
  }
}
