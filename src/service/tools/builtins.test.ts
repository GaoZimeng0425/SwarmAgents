import { describe, expect, it } from 'vitest'

import { registerBuiltinTools } from './builtins'
import { createToolRegistry, type ToolRunContext } from './registry'

const ctx: ToolRunContext = {
  taskId: 't',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: 'done', artifacts: [] } }),
  send: () => undefined,
  requestPermission: async () => 'grant',
}

describe('registerBuiltinTools', () => {
  const make = () => {
    const r = createToolRegistry()
    registerBuiltinTools(r)
    return r
  }

  it('registers the two peekaboo tools and the spawn tool', () => {
    const ids = make()
      .list()
      .map((s) => `${s.group}.${s.name}`)
      .sort()
    expect(ids).toEqual([
      'agent.spawn_sub_agent',
      'peekaboo.list_apps',
      'peekaboo.see_screen',
      'shell.run_shell',
    ])
  })

  it('peekaboo.* excludes the spawn tool', () => {
    const { tools, riskOf } = make().resolve(['peekaboo.*'], ctx)
    expect(tools.map((t) => t.name).sort()).toEqual(['list_apps', 'see_screen'])
    expect(riskOf('see_screen')).toBe('low')
  })

  it('spawn tool delegates to ctx.spawnChild and returns its summary', async () => {
    const { tools } = make().resolve(['agent.*'], ctx)
    const spawn = tools.find((t) => t.name === 'spawn_sub_agent')
    expect(spawn).toBeDefined()
    const result = await spawn!.execute('call-1', { goal: 'do a thing' })
    expect(result.content[0]).toEqual({ type: 'text', text: 'done' })
  })

  it('resolves the shell tool and gates dangerous commands dynamically', () => {
    const { tools, riskOf } = make().resolve(['shell.*'], ctx)
    expect(tools.map((t) => t.name)).toEqual(['run_shell'])
    expect(riskOf('run_shell', { command: 'rm -rf /' })).toBe('high')
    expect(riskOf('run_shell', { command: 'ls ~/Desktop' })).toBe('low')
  })
})
