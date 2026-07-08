import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'

import type { CronScheduler } from '../cron/scheduler'
import type { MemoryStore } from '../memory/store'
import { registerBuiltinTools } from './builtins'
import { createToolRegistry, type ToolRunContext } from './registry'

const fakeMemoryStore: MemoryStore = {
  store: () => undefined,
  recall: () => [],
  list: () => [],
  forget: () => false,
  close: () => undefined,
}

const ctx: ToolRunContext = {
  sessionId: 's',
  taskId: 't',
  spawnChild: async () => ({ runId: 'c', status: 'completed', summary: 'done', artifacts: [] }),
  requestPermission: async () => 'grant',
  findPeers: () => [],
}

describe('registerBuiltinTools', () => {
  const make = () => {
    const r = createToolRegistry()
    registerBuiltinTools(r)
    return r
  }

  it('registers the peekaboo, agent, and messaging tools', () => {
    const ids = make()
      .list()
      .map((s) => `${s.group}.${s.name}`)
      .sort()
    expect(ids).toEqual([
      'agent.delegate',
      'agent.find_agents',
      'agent.set_delegation_plan',
      'agent.update_plan',
      'authoring.write_agent',
      'authoring.write_skill',
      'fs.edit_file',
      'fs.glob',
      'fs.grep',
      'fs.list_dir',
      'fs.read_file',
      'fs.write_file',
      'peekaboo.click',
      'peekaboo.hotkey',
      'peekaboo.list_apps',
      'peekaboo.scroll',
      'peekaboo.see_screen',
      'peekaboo.type',
      'shell.run_shell',
      'time.current_time',
      'ui.render_ui',
      'vision.analyze_image',
      'vision.ocr_image',
      'weather.get_weather',
      'web.fetch',
      'web.web_search',
    ])
  })

  it('resolves render_ui by group.name, not bare name (gmail/article analysis allowlist)', () => {
    // The analysis runs inject ['ui.render_ui']; a bare 'render_ui' matches
    // nothing (specMatches wants group.name / group.*), leaving the agent with
    // no tool so it prints the call as text.
    expect(
      make()
        .resolve(['ui.render_ui'], ctx)
        .tools.map((t) => t.name)
    ).toEqual(['render_ui'])
    expect(make().resolve(['render_ui'], ctx).tools).toEqual([])
  })

  it('peekaboo.* resolves observation + interaction tools with proportional risk', () => {
    const { tools, riskOf } = make().resolve(['peekaboo.*'], ctx)
    expect(tools.map((t) => t.name).sort()).toEqual(['click', 'hotkey', 'list_apps', 'scroll', 'see_screen', 'type'])
    expect(riskOf('see_screen')).toBe('low')
    expect(riskOf('scroll')).toBe('low')
    expect(riskOf('click')).toBe('high')
    expect(riskOf('type')).toBe('high')
    expect(riskOf('hotkey')).toBe('high')
  })

  it('delegate spawn path delegates to ctx.spawnChild and returns its summary', async () => {
    const { tools } = make().resolve(['agent.*'], ctx)
    const delegate = tools.find((t) => t.name === 'delegate')
    expect(delegate).toBeDefined()
    const result = await delegate!.execute('call-1', { goal: 'do a thing' })
    expect(result.content[0]).toEqual({ type: 'text', text: 'done' })
  })

  it('resolves the shell tool and gates dangerous commands dynamically', () => {
    const { tools, riskOf } = make().resolve(['shell.*'], ctx)
    expect(tools.map((t) => t.name)).toEqual(['run_shell'])
    expect(riskOf('run_shell', { command: 'rm -rf /' })).toBe('high')
    expect(riskOf('run_shell', { command: 'ls ~/Desktop' })).toBe('low')
  })

  it('registers memory tools only when a store is provided', () => {
    const without = createToolRegistry()
    registerBuiltinTools(without)
    expect(without.list().some((s) => s.group === 'memory')).toBe(false)

    const withStore = createToolRegistry()
    registerBuiltinTools(withStore, { memoryStore: fakeMemoryStore })
    const { tools, riskOf } = withStore.resolve(['memory.*'], ctx)
    expect(tools.map((t) => t.name).sort()).toEqual(['forget', 'recall', 'remember'])
    expect(riskOf('remember')).toBe('low')
  })

  it('resolves the web fetch + search tools and gates private/non-http URLs dynamically', () => {
    const { tools, riskOf } = make().resolve(['web.*'], ctx)
    expect(tools.map((t) => t.name).sort()).toEqual(['fetch', 'web_search'])
    expect(riskOf('fetch', { url: 'https://example.com' })).toBe('low')
    expect(riskOf('fetch', { url: 'http://localhost:8080' })).toBe('high')
    expect(riskOf('web_search')).toBe('low')
  })

  it('resolves the fs tools and gates writes to sensitive paths dynamically', () => {
    const { tools, riskOf } = make().resolve(['fs.*'], ctx)
    expect(tools.map((t) => t.name).sort()).toEqual([
      'edit_file',
      'glob',
      'grep',
      'list_dir',
      'read_file',
      'write_file',
    ])
    expect(riskOf('read_file')).toBe('low')
    expect(riskOf('write_file', { path: '/etc/hosts' })).toBe('high')
    expect(riskOf('write_file', { path: `${homedir()}/notes.txt` })).toBe('low')
  })
})

const fakeScheduler = {
  add: () => ({ id: 'x', nextRun: 0 }),
  remove: () => true,
  listForSession: () => [],
  listAll: () => [],
  latestRunForJob: () => null,
  runsForJob: () => [],
  start: () => undefined,
  runJobNow: () => undefined,
  dispose: () => undefined,
} as CronScheduler

describe('registerBuiltinTools with a scheduler', () => {
  it('registers the cron tools when a scheduler is injected', () => {
    const r = createToolRegistry()
    registerBuiltinTools(r, { scheduler: fakeScheduler })
    const ids = r.list().map((s) => `${s.group}.${s.name}`)
    expect(ids).toContain('cron.schedule_task')
    expect(ids).toContain('cron.list_scheduled_tasks')
    expect(ids).toContain('cron.cancel_scheduled_task')
  })

  it('omits the cron tools when no scheduler is injected', () => {
    const r = createToolRegistry()
    registerBuiltinTools(r)
    expect(r.list().some((s) => s.group === 'cron')).toBe(false)
  })
})
