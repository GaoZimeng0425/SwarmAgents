import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BiliSummary, BiliVideo } from '@shared/types/bilibili'
import { describe, expect, it } from 'vitest'
import { noteFilename, renderNote, writeNote } from './obsidian'

const video: BiliVideo = {
  bvid: 'BV1x',
  title: 'How to: build/things',
  cover: '',
  author: 'up主',
  durationSec: 65,
  intro: '',
  source: 'CS',
}
const summary: BiliSummary = {
  gist: '主旨一句话',
  points: ['要点A', '要点B'],
  experience: [],
  pitfalls: ['坑1'],
  steps: ['第一步', '第二步'],
}

describe('noteFilename', () => {
  it('strips path-unsafe characters and appends the bvid', () => {
    expect(noteFilename('How to: build/things', 'BV1x')).toBe('How to build things-BV1x.md')
  })
  it('falls back to the bvid when the title sanitizes to empty', () => {
    expect(noteFilename('///', 'BV9')).toBe('BV9-BV9.md')
  })
})

describe('renderNote', () => {
  it('renders quoted frontmatter, skips empty sections, numbers steps', () => {
    const md = renderNote(video, summary, '2026-06-28')
    expect(md).toContain('title: "How to: build/things"')
    expect(md).toContain('bvid: BV1x')
    expect(md).toContain('url: https://www.bilibili.com/video/BV1x')
    expect(md).toContain('duration: 1:05')
    expect(md).toContain('processed: 2026-06-28')
    expect(md).toContain('## 核心要点\n\n- 要点A\n- 要点B')
    expect(md).toContain('## 踩坑 / 注意\n\n- 坑1')
    expect(md).toContain('## 可执行步骤\n\n1. 第一步\n2. 第二步')
    // experience is empty -> its heading must not appear
    expect(md).not.toContain('## 可复用经验')
  })
})

describe('writeNote', () => {
  it('returns no_vault when config is null', async () => {
    const r = await writeNote(null, video, summary, '2026-06-28')
    expect(r).toEqual({ ok: false, code: 'no_vault', message: expect.any(String) })
  })
  it('writes the note under vaultPath/subdir and returns the path', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'obs-'))
    const r = await writeNote({ vaultPath: vault, subdir: 'bili' }, video, summary, '2026-06-28')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.path).toBe(join(vault, 'bili', 'How to build things-BV1x.md'))
      const written = await readFile(r.path, 'utf8')
      expect(written).toContain('主旨一句话')
    }
  })
})
