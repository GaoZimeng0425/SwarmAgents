import type { AgentTool } from '@earendil-works/pi-agent-core'
import { describe, expect, it } from 'vitest'

import { createToolRegistry, type ToolRunContext, type ToolSpec } from './registry'

const fakeTool = (name: string): AgentTool =>
  ({
    name,
    label: name,
    description: '',
    parameters: { type: 'object' },
    execute: async () => ({ content: [] }),
  }) as unknown as AgentTool

const spec = (group: string, name: string, risk: 'low' | 'medium' | 'high'): ToolSpec => ({
  group,
  name,
  risk,
  source: 'builtin',
  build: () => fakeTool(name),
})

const ctx: ToolRunContext = {
  sessionId: 's',
  taskId: 't',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  send: () => undefined,
  requestPermission: async () => 'grant',
}

describe('ToolRegistry', () => {
  const make = () => {
    const r = createToolRegistry()
    r.register(spec('peekaboo', 'see_screen', 'low'))
    r.register(spec('peekaboo', 'list_apps', 'low'))
    r.register(spec('agent', 'spawn_sub_agent', 'medium'))
    return r
  }

  it('matches group globs and excludes other groups', () => {
    const { tools } = make().resolve(['peekaboo.*'], ctx)
    expect(tools.map((t) => t.name).sort()).toEqual(['list_apps', 'see_screen'])
  })

  it('matches a fully-qualified name', () => {
    const { tools } = make().resolve(['peekaboo.see_screen'], ctx)
    expect(tools.map((t) => t.name)).toEqual(['see_screen'])
  })

  it('matches everything for * and all', () => {
    expect(make().resolve(['*'], ctx).tools).toHaveLength(3)
    expect(make().resolve(['all'], ctx).tools).toHaveLength(3)
  })

  it('riskOf returns spec risk, defaulting unknown to medium', () => {
    const { riskOf } = make().resolve(['*'], ctx)
    expect(riskOf('see_screen')).toBe('low')
    expect(riskOf('spawn_sub_agent')).toBe('medium')
    expect(riskOf('does_not_exist')).toBe('medium')
  })

  it('riskFor overrides static risk per call; specs without it use static risk', () => {
    const r = createToolRegistry()
    r.register({
      group: 'shell',
      name: 'run_shell',
      risk: 'low',
      riskFor: (a) => ((a as { command?: string }).command === 'danger' ? 'high' : 'low'),
      source: 'builtin',
      build: () => fakeTool('run_shell'),
    })
    r.register(spec('peekaboo', 'see_screen', 'low'))
    const { riskOf } = r.resolve(['*'], ctx)
    expect(riskOf('run_shell', { command: 'danger' })).toBe('high')
    expect(riskOf('run_shell', { command: 'safe' })).toBe('low')
    expect(riskOf('see_screen')).toBe('low') // static, no args
    expect(riskOf('unknown', {})).toBe('medium')
  })

  it('includes an MCP-sourced tool via the register seam', () => {
    const r = createToolRegistry()
    r.register({ group: 'notion', name: 'search', risk: 'medium', source: 'mcp', build: () => fakeTool('search') })
    const { tools } = r.resolve(['notion.*'], ctx)
    expect(tools.map((t) => t.name)).toEqual(['search'])
  })
})
