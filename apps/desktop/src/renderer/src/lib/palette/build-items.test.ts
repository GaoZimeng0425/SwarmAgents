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
  submitPrompt: vi.fn().mockResolvedValue({ sessionId: 'new-1' }),
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

// Regression (C1): each kind's run() must be wired to a real callback, not a no-op.
describe('buildItems — run() wiring', () => {
  it('chat run() navigates to the session route', () => {
    const items = buildItems('mixed', 'Gmail', baseInputs, cb)
    const chat = items.find((i) => i.kind === 'chat')!
    chat.run()
    expect(cb.navigate).toHaveBeenCalledWith('/session/s1')
  })
  it('taskRun run() navigates to the run session route', () => {
    const items = buildItems('task', '', baseInputs, cb)
    const run = items.find((i) => i.kind === 'taskRun')!
    run.run()
    expect(cb.navigate).toHaveBeenCalledWith('/session/s1')
  })
  it('taskSched run() navigates to the scheduled route', () => {
    const items = buildItems('task', '', baseInputs, cb)
    const sched = items.find((i) => i.kind === 'taskSched')!
    sched.run()
    expect(cb.navigate).toHaveBeenCalledWith('/scheduled')
  })
  it('memory run() opens settings (general tab)', () => {
    const items = buildItems('mixed', '偏好', baseInputs, cb)
    const memory = items.find((i) => i.kind === 'memory')!
    memory.run()
    expect(cb.openSettings).toHaveBeenCalledWith('general')
  })
  it('skill run() opens settings on the skills tab', () => {
    const items = buildItems('mixed', 'imagegen', baseInputs, cb)
    const skill = items.find((i) => i.kind === 'skill')!
    skill.run()
    expect(cb.openSettings).toHaveBeenCalledWith('skills')
  })
})

describe('buildItems — mixed scope', () => {
  it('empty term yields the design home: 继续未完成 + 建议操作 + 最近对话 + 快捷入口 (no hero)', () => {
    const items = buildItems('mixed', '', baseInputs, cb)
    // No dispatch hero in the empty home — nothing to submit until the user types.
    expect(items.find((i) => i.kind === 'dispatch')).toBeUndefined()
    // 继续未完成: the running run surfaced as a resume card (plan 1/2 = 50%).
    const resume = items.find((i) => i.section === '继续未完成')
    expect(resume?.title).toBe('继续:抓取邮件')
    expect(resume?.subtitle).toBe('上次进行到 50%·点此继续')
    // 建议操作 carries 新建对话 with its ⌘N shortcut.
    const newChat = items.find((i) => i.section === '建议操作' && i.title === '新建对话')
    expect(newChat?.shortcut).toBe('⌘N')
    // 最近对话 + 快捷入口 present.
    expect(items.some((i) => i.kind === 'chat' && i.section === '最近对话')).toBe(true)
    expect(items.some((i) => i.kind === 'service' && i.section === '快捷入口')).toBe(true)
  })
  it('with-query hero dispatch run() submits goal + navigates', async () => {
    const items = buildItems('mixed', '分析这段视频', baseInputs, cb)
    const hero = items.find((i) => i.kind === 'dispatch')!
    expect(hero).toBeTruthy()
    await hero.run()
    expect(cb.submitPrompt).toHaveBeenCalledWith('分析这段视频', 'ceo') // default formation
    expect(cb.navigate).toHaveBeenCalledWith('/session/new-1')
  })
  it('empty term cannot submit a blank goal — there is no dispatch hero at all', () => {
    // The old empty-goal guard is now structural: the empty home omits the hero,
    // so a bare Enter runs the first real row instead of dispatching an empty goal.
    vi.mocked(cb.submitPrompt).mockClear()
    const items = buildItems('mixed', '', baseInputs, cb)
    expect(items.some((i) => i.kind === 'dispatch')).toBe(false)
    expect(cb.submitPrompt).not.toHaveBeenCalled()
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
    expect(cb.submitPrompt).toHaveBeenCalledWith('分析这段视频', 'ceo')
  })
})
