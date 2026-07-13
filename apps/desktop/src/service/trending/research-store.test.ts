import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RepoResearch } from '@swarm/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createRepoResearchStore } from './research-store'

const research: RepoResearch = {
  gist: 'g',
  why: 'w',
  highlights: ['h1', 'h2'],
  forWhom: 'devs',
  verdict: 'v',
  verdictTag: '值得关注',
  verdictTone: 'recommend',
}

describe('createRepoResearchStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarm-repo-research-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('get returns null before any save', () => {
    const store = createRepoResearchStore({ userDataDir: dir })
    expect(store.get('sst/opencode')).toEqual({ research: null, researchedAt: null })
  })

  it('save then get round-trips and lists the name; persists across reload', () => {
    const store = createRepoResearchStore({ userDataDir: dir })
    store.save('sst/opencode', research)
    const got = store.get('sst/opencode')
    expect(got.research).toEqual(research)
    expect(got.researchedAt).toEqual(expect.any(String))
    expect(store.names()).toEqual(['sst/opencode'])

    // A fresh store instance loads the persisted file.
    const reloaded = createRepoResearchStore({ userDataDir: dir })
    expect(reloaded.get('sst/opencode').research).toEqual(research)
    expect(reloaded.names()).toEqual(['sst/opencode'])
  })

  it('persists and reloads a research record with a summary', () => {
    const store = createRepoResearchStore({ userDataDir: dir })
    const withSummary: RepoResearch = { ...research, summary: '## 简报\n这是一个终端 agent。' }
    store.save('sst/opencode', withSummary)
    const reloaded = createRepoResearchStore({ userDataDir: dir })
    expect(reloaded.get('sst/opencode').research).toEqual(withSummary)
  })

  it('loads a legacy record without summary (backward compatible)', () => {
    // A pre-summary record on disk must still load; summary resolves to undefined.
    writeFileSync(
      join(dir, 'repo-research.json'),
      JSON.stringify({ 'sst/opencode': { research, researchedAt: '2026-01-01T00:00:00.000Z' } })
    )
    const store = createRepoResearchStore({ userDataDir: dir })
    expect(store.get('sst/opencode').research).toEqual(research)
  })
})
