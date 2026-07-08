// Persists Agent-研究 results for trending repos, keyed by repoName ("owner/name").
// The trending list itself is fetched live from OSSInsight and never stored, so
// this cache stands alone (unlike article/store.ts which also owns the records).
// Simpler than the article store: research is only ever get / save / listNames —
// there is no add or delete surface.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '@shared/logger'
import type { RepoResearch } from '@swarm/protocol'
import { z } from 'zod'

const log = createLogger({ process: 'service' }).child({ component: 'repo-research-store' })

const RepoResearchRecordSchema = z.object({
  research: z.object({
    gist: z.string(),
    why: z.string(),
    highlights: z.array(z.string()),
    forWhom: z.string(),
    verdict: z.string(),
    verdictTag: z.string(),
    verdictTone: z.enum(['recommend', 'adopt', 'caution', 'watch']),
  }),
  researchedAt: z.string(),
})

type RepoResearchRecord = z.infer<typeof RepoResearchRecordSchema>

const FileSchema = z.record(z.string(), RepoResearchRecordSchema)

export type RepoResearchStore = {
  get(repoName: string): { research: RepoResearch | null; researchedAt: string | null }
  save(repoName: string, research: RepoResearch): void
  /** Repo names that already have a cached research result — drives the list "AI" badge. */
  names(): string[]
}

export function createRepoResearchStore(deps: { userDataDir: string }): RepoResearchStore {
  const file = join(deps.userDataDir, 'repo-research.json')
  let cache = new Map<string, RepoResearchRecord>()

  load()

  function load(): void {
    try {
      const raw = readFileSync(file, 'utf8')
      const parsed = FileSchema.safeParse(JSON.parse(raw))
      if (parsed.success) {
        cache = new Map(Object.entries(parsed.data))
      } else {
        log.warn({ msg: 'repo research store parse failed, starting empty' })
      }
    } catch {
      // first run — file does not exist yet
    }
  }

  function persist(): void {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(cache), null, 2))
      renameSync(tmp, file)
    } catch (err) {
      log.error({ msg: 'repo research store write failed', err: err instanceof Error ? err.message : String(err) })
    }
  }

  return {
    get(repoName) {
      const r = cache.get(repoName)
      return { research: r?.research ?? null, researchedAt: r?.researchedAt ?? null }
    },
    save(repoName, research) {
      cache.set(repoName, { research, researchedAt: new Date().toISOString() })
      persist()
    },
    names() {
      return [...cache.keys()]
    },
  }
}
