import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listArtifacts } from './artifacts-service'

let cwd: string
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'swarm-artifacts-'))
})
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

// Bilibili source is injected (so the test doesn't touch the real store).
const noBilibili = async () => []

describe('listArtifacts', () => {
  it('returns files under cwd sorted by mtime desc', async () => {
    const a = join(cwd, 'a.md')
    const b = join(cwd, 'b.md')
    await writeFile(a, 'older', 'utf8')
    await new Promise((r) => setTimeout(r, 20))
    await writeFile(b, 'newer', 'utf8')
    const out = await listArtifacts({ cwd, bilibiliSource: noBilibili })
    const names = out.map((e) => e.name)
    expect(names).toContain('a.md')
    expect(names).toContain('b.md')
    expect(names.indexOf('b.md')).toBeLessThan(names.indexOf('a.md'))
  })

  it('skips node_modules and .git', async () => {
    await mkdir(join(cwd, 'node_modules'), { recursive: true })
    await mkdir(join(cwd, '.git'), { recursive: true })
    await writeFile(join(cwd, 'node_modules', 'pkg.js'), 'x')
    await writeFile(join(cwd, '.git', 'config'), 'x')
    await writeFile(join(cwd, 'real.md'), 'x')
    const out = await listArtifacts({ cwd, bilibiliSource: noBilibili })
    expect(out.map((e) => e.name)).toEqual(['real.md'])
  })

  it('skips hidden files (dotfiles)', async () => {
    await writeFile(join(cwd, '.secret'), 'x')
    await writeFile(join(cwd, 'visible.txt'), 'x')
    const out = await listArtifacts({ cwd, bilibiliSource: noBilibili })
    expect(out.map((e) => e.name)).toEqual(['visible.txt'])
  })

  it('caps directory depth at 3', async () => {
    await mkdir(join(cwd, 'a', 'b', 'c', 'd'), { recursive: true })
    await writeFile(join(cwd, 'a', 'b', 'c', 'd', 'deep.md'), 'x')
    await writeFile(join(cwd, 'shallow.md'), 'x')
    const out = await listArtifacts({ cwd, bilibiliSource: noBilibili })
    expect(out.map((e) => e.name)).not.toContain('deep.md')
    expect(out.map((e) => e.name)).toContain('shallow.md')
  })

  it('filters by substring (case-insensitive) across name + origin', async () => {
    await writeFile(join(cwd, 'report-FINAL.md'), 'x')
    await writeFile(join(cwd, 'notes.txt'), 'x')
    const out = await listArtifacts({ cwd, bilibiliSource: noBilibili, query: 'final' })
    expect(out.map((e) => e.name)).toEqual(['report-FINAL.md'])
  })

  it('respects the limit', async () => {
    for (let i = 0; i < 8; i++) {
      await writeFile(join(cwd, `f${i}.md`), 'x')
      await new Promise((r) => setTimeout(r, 5))
    }
    const out = await listArtifacts({ cwd, bilibiliSource: noBilibili, limit: 3 })
    expect(out).toHaveLength(3)
  })

  it('includes bilibili analyses from the injected source', async () => {
    const bilibili = async () => [{ bvid: 'BV1xx', title: 'RAG 教程', origin: 'Bilibili' }]
    const out = await listArtifacts({ cwd, bilibiliSource: bilibili })
    const bili = out.find((e) => e.kind === 'bilibili-analysis')
    expect(bili).toBeDefined()
    expect(bili?.name).toBe('RAG 教程')
    expect(bili?.ref).toBe('BV1xx')
  })

  it('returns empty array when cwd has no matching files', async () => {
    const out = await listArtifacts({ cwd, bilibiliSource: noBilibili })
    expect(out).toEqual([])
  })
})
