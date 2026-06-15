import type { Skill } from '@shared/types/skill'
import { describe, expect, it, vi } from 'vitest'

import type { SkillStore } from '../skills/store'
import { useSkillSpec } from './skill'

function storeWith(skills: Skill[]): SkillStore {
  return {
    list: () => skills,
    get: (name) => skills.find((s) => s.name === name),
    reload: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
  }
}

const ctx = { taskId: 't', spawnChild: vi.fn(), send: vi.fn(), requestPermission: vi.fn() } as never

describe('useSkillSpec', () => {
  it('wraps the body in a <skill> tag with its location for a known name', async () => {
    const spec = useSkillSpec(
      storeWith([{ name: 'greet', description: 'd', body: 'Say hello.', filePath: '/skills/greet/SKILL.md' }])
    )
    expect(spec).toMatchObject({ group: 'skill', name: 'use_skill', risk: 'low' })
    const tool = spec.build(ctx)
    const res = await tool.execute('c', { name: 'greet' })
    expect(res.content[0]).toEqual({
      type: 'text',
      text: '<skill name="greet" location="/skills/greet/SKILL.md">\nReferences are relative to /skills/greet.\n\nSay hello.\n</skill>',
    })
  })

  it('lists available skills when the name is unknown', async () => {
    const tool = useSkillSpec(storeWith([{ name: 'greet', description: 'd', body: 'b' }])).build(ctx)
    const res = await tool.execute('c', { name: 'nope' })
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain('No skill named "nope"')
    expect(text).toContain('greet')
  })
})
