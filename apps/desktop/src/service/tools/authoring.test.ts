import { describe, expect, it } from 'vitest'

import { writeAgentSpec, writeSkillSpec } from './authoring'
import type { ToolRunContext } from './registry'

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('')

function ctxWith(over: Partial<ToolRunContext>): ToolRunContext {
  return { sessionId: 's', findPeers: () => [], ...over } as unknown as ToolRunContext
}

describe('write_agent', () => {
  it('builds an AgentDefinition and calls ctx.writeAgent, reporting success', async () => {
    let saved: { id?: string } = {}
    const tool = writeAgentSpec().build(
      ctxWith({
        writeAgent: (def) => {
          saved = def
          return { ok: true, agents: [] }
        },
      })
    )
    const res = await tool.execute('1', {
      id: 'docs-writer',
      name: 'Docs Writer',
      description: 'Use to write docs.',
      systemPrompt: 'You write docs.',
      toolScope: 'all',
      team: 'docs',
      role: 'docs-writer',
    })
    expect(saved.id).toBe('docs-writer')
    expect(textOf(res)).toMatch(/created|saved/i)
  })

  it('reports the validation error when the store rejects the definition', async () => {
    const tool = writeAgentSpec().build(ctxWith({ writeAgent: () => ({ ok: false, code: 'invalid', message: 'bad id' }) }))
    const res = await tool.execute('1', { id: 'X', name: 'n', description: 'd', systemPrompt: 'p', toolScope: 'all' })
    expect(textOf(res)).toContain('bad id')
  })

  it('errors clearly when authoring is unavailable to this agent', async () => {
    const tool = writeAgentSpec().build(ctxWith({})) // no writeAgent injected
    const res = await tool.execute('1', { id: 'a', name: 'n', description: 'd', systemPrompt: 'p', toolScope: 'all' })
    expect(textOf(res)).toMatch(/not available|unavailable/i)
  })
})

describe('write_skill', () => {
  it('builds a Skill and calls ctx.writeSkill', async () => {
    let saved: { name?: string } = {}
    const tool = writeSkillSpec().build(
      ctxWith({
        writeSkill: (s) => {
          saved = s
          return { ok: true, skills: [] }
        },
      })
    )
    const res = await tool.execute('1', { name: 'my-skill', description: 'Use to do X.', body: '# steps' })
    expect(saved.name).toBe('my-skill')
    expect(textOf(res)).toMatch(/created|saved/i)
  })
})
