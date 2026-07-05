// apps/desktop/src/renderer/src/lib/palette/build-items.test.ts
import { describe, expect, it, vi } from 'vitest'

import { type BuildInputs, buildItems, type Callbacks } from './build-items'

const baseInputs: BuildInputs = {
  currentSessionId: null,
  sessions: [
    { id: 's1', title: 'Gmail 摘要', lastActiveAt: 1, agentType: 'ceo' },
    { id: 's2', title: 'Bilibili 分析', lastActiveAt: 2 },
  ],
  runningRuns: [
    {
      id: 'r1',
      sessionId: 's1',
      goal: '抓取邮件',
      status: 'running',
      summary: null,
      plan: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'pending' },
      ],
    },
  ],
  cronJobs: [
    {
      id: 'c1',
      sessionId: 's-sched',
      name: '每日日报',
      cron: '0 9 * * *',
      nextRun: 100,
      lastRun: 50,
      lastStatus: 'ok',
    },
  ],
  formations: [
    { id: 'ceo', label: '公司 (CEO)' },
    { id: 'research-head', label: '研究编队' },
  ],
  artifacts: [
    { kind: 'file', name: 'report.md', ref: '/tmp/report.md', origin: '/tmp', modifiedAt: 99 },
    { kind: 'bilibili-analysis', name: 'BV1xx', ref: 'BV1xx', origin: 'Bilibili', modifiedAt: 88 },
  ],
  memory: [{ id: 'm1', key: 'pref', namespace: 'user', category: '偏好', content: '偏好深色', timestamp: 5 }],
  skills: [{ name: 'imagegen', description: '生成图像', enabled: true }],
  services: [{ id: 'bilibili', label: 'Bilibili', route: '/bilibili' }],
}

const cb: Callbacks = {
  navigate: vi.fn(),
  openSettings: vi.fn(),
  cycleTheme: vi.fn(),
  exportMarkdown: vi.fn(),
  setComposerAgent: vi.fn(),
  openArtifact: vi.fn(),
  submitGoal: vi.fn().mockResolvedValue({ sessionId: 'new-1' }),
}

describe('buildItems — command scope', () => {
  it('surfaces all built-in commands when term is empty', () => {
    const items = buildItems('command', '', baseInputs, cb)
    const titles = items.map((i) => i.title)
    expect(titles).toEqual(
      expect.arrayContaining([
        '新建对话',
        '新建定时任务',
        '新建编队',
        '打开设置',
        '切换外观',
        '导出当前对话为 Markdown',
      ])
    )
  })
  it('filters commands by term substring', () => {
    const items = buildItems('command', '设置', baseInputs, cb)
    expect(items.map((i) => i.title)).toEqual(['打开设置'])
  })
  it('export Markdown command run() calls exportMarkdown with NO selected session yields nothing (guarded upstream)', () => {
    // The command's run() always calls exportMarkdown — the upstream caller
    // decides whether it's a no-op. We only assert the wiring here.
    const items = buildItems('command', '导出', baseInputs, cb)
    expect(items[0].title).toBe('导出当前对话为 Markdown')
    items[0].run()
    expect(cb.exportMarkdown).toHaveBeenCalled()
  })
})

describe('buildItems — agent scope', () => {
  it('lists formations filtered by term', () => {
    const items = buildItems('agent', '研究', baseInputs, cb)
    expect(items.map((i) => i.title)).toEqual(['研究编队'])
    expect(items[0].kind).toBe('agent')
  })
  it('agent run() prefills composer and navigates home', () => {
    const items = buildItems('agent', '', baseInputs, cb)
    items.find((i) => i.title === '研究编队')!.run()
    expect(cb.setComposerAgent).toHaveBeenCalledWith('research-head')
    expect(cb.navigate).toHaveBeenCalledWith('/')
  })
})

describe('buildItems — task scope', () => {
  it('emits taskRun + taskSched kinds', () => {
    const items = buildItems('task', '', baseInputs, cb)
    const kinds = new Set(items.map((i) => i.kind))
    expect(kinds.has('taskRun')).toBe(true)
    expect(kinds.has('taskSched')).toBe(true)
  })
})

describe('buildItems — file scope', () => {
  it('lists artifacts filtered by name', () => {
    const items = buildItems('file', 'report', baseInputs, cb)
    expect(items.map((i) => i.title)).toEqual(['report.md'])
    items[0].run()
    expect(cb.openArtifact).toHaveBeenCalledWith('/tmp/report.md')
  })
})

describe('buildItems — mixed scope', () => {
  it('empty term yields hero dispatch + recent sessions + commands + services', () => {
    const items = buildItems('mixed', '', baseInputs, cb)
    const titles = items.map((i) => i.title)
    expect(titles).toContain('把目标交给 Agent') // hero dispatch item
    expect(items.find((i) => i.kind === 'dispatch')).toBeTruthy()
    expect(items.some((i) => i.kind === 'command')).toBe(true)
    expect(items.some((i) => i.kind === 'service')).toBe(true)
  })
  it('with-query hero dispatch run() submits goal + navigates', async () => {
    const items = buildItems('mixed', '分析这段视频', baseInputs, cb)
    const hero = items.find((i) => i.kind === 'dispatch')!
    expect(hero).toBeTruthy()
    await hero.run()
    expect(cb.submitGoal).toHaveBeenCalledWith('分析这段视频', 'ceo') // default formation
    expect(cb.navigate).toHaveBeenCalledWith('/session/new-1')
  })
  it('with-query filters sessions/commands by term', () => {
    const items = buildItems('mixed', 'Gmail', baseInputs, cb)
    const chats = items.filter((i) => i.kind === 'chat').map((i) => i.title)
    expect(chats).toEqual(['Gmail 摘要'])
  })
})

// Regression: term must be trimmed before filtering so leading/trailing
// whitespace does not silently break the substring match.
describe('buildItems — term trimming', () => {
  it('trims whitespace in the term before filtering (command scope)', () => {
    const items = buildItems('command', '  设置  ', baseInputs, cb)
    expect(items.map((i) => i.title)).toEqual(['打开设置'])
  })
  it('trims whitespace in the term before filtering (mixed scope)', () => {
    const items = buildItems('mixed', '  Gmail  ', baseInputs, cb)
    expect(items.some((i) => i.kind === 'chat' && i.title === 'Gmail 摘要')).toBe(true)
  })
  it('mixed hero dispatch submits the TRIMMED goal (no trailing spaces)', async () => {
    const items = buildItems('mixed', '  分析这段视频  ', baseInputs, cb)
    const hero = items.find((i) => i.kind === 'dispatch')!
    await hero.run()
    expect(cb.submitGoal).toHaveBeenCalledWith('分析这段视频', 'ceo')
  })
})
