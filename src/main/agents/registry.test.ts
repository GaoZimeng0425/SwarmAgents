import type { AgentDefinition } from '@shared/types/agent'
import { describe, expect, it } from 'vitest'

import { createAgentRegistry } from './registry'

describe('createAgentRegistry', () => {
  it('contains built-in definitions', () => {
    const reg = createAgentRegistry()
    expect(reg.get('default')).toBeDefined()
    expect(reg.get('researcher')).toBeDefined()
    expect(reg.get('executor')).toBeDefined()
  })

  it('returns undefined for unknown id', () => {
    const reg = createAgentRegistry()
    expect(reg.get('nonexistent')).toBeUndefined()
  })

  it('list returns all built-in definitions', () => {
    const reg = createAgentRegistry()
    const list = reg.list()
    expect(list.length).toBeGreaterThanOrEqual(3)
    const ids = list.map((d) => d.id)
    expect(ids).toContain('default')
    expect(ids).toContain('researcher')
    expect(ids).toContain('executor')
  })

  it('register adds a new definition', () => {
    const reg = createAgentRegistry()
    const custom: AgentDefinition = {
      id: 'custom-test',
      name: 'Test Agent',
      systemPrompt: 'test prompt',
      toolScope: 'peekaboo',
      maxIterations: 10,
    }
    reg.register(custom)
    expect(reg.get('custom-test')).toBe(custom)
    expect(reg.list().length).toBeGreaterThanOrEqual(4)
  })

  it('register overwrites existing definition', () => {
    const reg = createAgentRegistry()
    const original = reg.get('default')!
    const modified: AgentDefinition = {
      ...original,
      systemPrompt: 'modified prompt',
    }
    reg.register(modified)
    expect(reg.get('default')!.systemPrompt).toBe('modified prompt')
  })
})
