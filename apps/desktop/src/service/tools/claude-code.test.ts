import { describe, expect, it, vi } from 'vitest'

import type { CCObservation, ClaudeCodeManager } from '../claude-code/manager'
import { claudeCodeSpecs } from './claude-code'
import type { ToolRunContext } from './registry'

function obs(over: Partial<CCObservation> = {}): CCObservation {
  return { ccSessionId: 'cc1', status: 'idle', events: [], ...over }
}

function fakeManager(over: Partial<ClaudeCodeManager> = {}): ClaudeCodeManager {
  return {
    start: vi.fn(async () => obs({ events: [{ kind: 'text', text: 'echo:hi' }] })),
    send: vi.fn(async () => obs()),
    observe: vi.fn(() => obs()),
    approve: vi.fn(async () => obs()),
    interrupt: vi.fn(async () => obs()),
    stop: vi.fn(() => obs({ status: 'completed' })),
    has: vi.fn(() => true),
    dispose: vi.fn(),
    ...over,
  }
}

const ctx = { cwd: '/work' } as unknown as ToolRunContext

function toolByName(manager: ClaudeCodeManager, name: string) {
  const spec = claudeCodeSpecs(manager).find((s) => s.name === name)
  if (!spec) throw new Error(`no spec ${name}`)
  return spec.build(ctx)
}

describe('cc_* tools', () => {
  it('registers the cc_* tools under the claude-code group', () => {
    const specs = claudeCodeSpecs(fakeManager())
    expect(specs.map((s) => s.name).sort()).toEqual([
      'cc_approve',
      'cc_interrupt',
      'cc_observe',
      'cc_send',
      'cc_start',
      'cc_stop',
    ])
    expect(specs.every((s) => s.group === 'claude-code')).toBe(true)
    expect(specs.find((s) => s.name === 'cc_start')?.risk).toBe('high')
    expect(specs.find((s) => s.name === 'cc_approve')?.risk).toBe('high')
    expect(specs.find((s) => s.name === 'cc_observe')?.risk).toBe('low')
  })

  it('cc_start defaults cwd to the task cwd and returns a handle', async () => {
    const manager = fakeManager()
    const tool = toolByName(manager, 'cc_start')
    const res = await tool.execute('t1', { prompt: 'do it' })

    expect(manager.start).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'do it', cwd: '/work', ccSessionId: expect.any(String) })
    )
    expect(res.details?.handle).toEqual(expect.any(String))
    expect(res.content[0].text).toContain('echo:hi')
  })

  it('cc_send forwards the handle and message', async () => {
    const manager = fakeManager()
    const tool = toolByName(manager, 'cc_send')
    await tool.execute('t1', { handle: 'cc1', message: 'go left' })
    expect(manager.send).toHaveBeenCalledWith('cc1', 'go left')
  })

  it('cc_start forwards mode and resume', async () => {
    const manager = fakeManager()
    const tool = toolByName(manager, 'cc_start')
    await tool.execute('t1', { prompt: 'do it', mode: 'bypassPermissions', resume: 'sdk-prev' })
    expect(manager.start).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'bypassPermissions', resume: 'sdk-prev' })
    )
  })

  it('cc_approve forwards handle, requestId and decision', async () => {
    const manager = fakeManager()
    const tool = toolByName(manager, 'cc_approve')
    await tool.execute('t1', { handle: 'cc1', requestId: 'req-1', decision: 'allow' })
    expect(manager.approve).toHaveBeenCalledWith('cc1', 'req-1', 'allow')
  })

  it('cc_start charges the cost delta to the task budget', async () => {
    const reportExternalUsage = vi.fn()
    const budgetCtx = { cwd: '/work', reportExternalUsage } as unknown as ToolRunContext
    const manager = fakeManager({
      start: vi.fn(async () => obs({ costDeltaUsd: 0.05, usage: { inputTokens: 10, outputTokens: 20 } })),
    })
    const spec = claudeCodeSpecs(manager).find((s) => s.name === 'cc_start')
    if (!spec) throw new Error('no cc_start')
    await spec.build(budgetCtx).execute('t1', { prompt: 'x' })
    expect(reportExternalUsage).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0.05 }))
  })

  it('cc_observe does not charge the budget', async () => {
    const reportExternalUsage = vi.fn()
    const budgetCtx = { cwd: '/work', reportExternalUsage } as unknown as ToolRunContext
    const manager = fakeManager()
    const spec = claudeCodeSpecs(manager).find((s) => s.name === 'cc_observe')
    if (!spec) throw new Error('no cc_observe')
    await spec.build(budgetCtx).execute('t1', { handle: 'cc1' })
    expect(reportExternalUsage).not.toHaveBeenCalled()
  })

  it('render surfaces a pending approval prompt', async () => {
    const manager = fakeManager({
      observe: vi.fn(() =>
        obs({ status: 'needs_approval', pendingApproval: { requestId: 'req-9', toolName: 'Bash' } })
      ),
    })
    const tool = toolByName(manager, 'cc_observe')
    const res = await tool.execute('t1', { handle: 'cc1' })
    expect(res.content[0].text).toContain('needs_approval')
    expect(res.content[0].text).toContain('req-9')
    expect(res.content[0].text).toContain('cc_approve')
  })

  it('cc_stop reports completed status', async () => {
    const manager = fakeManager()
    const tool = toolByName(manager, 'cc_stop')
    const res = await tool.execute('t1', { handle: 'cc1' })
    expect(manager.stop).toHaveBeenCalledWith('cc1')
    expect(res.content[0].text).toContain('status: completed')
  })
})
