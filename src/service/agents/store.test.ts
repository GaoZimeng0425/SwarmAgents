import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDefinition } from '@shared/types/agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAgentStore, parseAgent, serializeAgent } from './store'

const def = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: 'researcher',
  name: 'Research Agent',
  description: 'Use when read-only investigation is needed.',
  systemPrompt: 'You are a research agent.',
  toolScope: 'peekaboo',
  maxIterations: 15,
  ...over,
})

describe('parseAgent', () => {
  it('parses frontmatter fields + body as systemPrompt, with id from the folder', () => {
    const raw = serializeAgent(def())
    expect(parseAgent(raw, 'researcher')).toEqual(def())
  })

  it('round-trips a model override and a description with a colon', () => {
    const d = def({ model: 'claude-haiku-4-5', description: 'Use when: investigating, read-only.' })
    expect(parseAgent(serializeAgent(d), d.id)).toEqual(d)
  })

  it('defaults maxIterations to 25 when omitted', () => {
    const raw = '---\nname: X\ndescription: d\ntoolScope: all\n---\n\nbody'
    expect(parseAgent(raw, 'x')?.maxIterations).toBe(25)
  })

  it('returns undefined for an invalid toolScope', () => {
    const raw = '---\nname: X\ndescription: d\ntoolScope: bogus\n---\n\nbody'
    expect(parseAgent(raw, 'x')).toBeUndefined()
  })

  it('returns undefined when required fields are missing', () => {
    expect(parseAgent('just a body, no frontmatter', 'x')).toBeUndefined()
  })
})

describe('createAgentStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarm-agents-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('saves an agent to <dir>/<id>/AGENT.md and lists it', () => {
    const store = createAgentStore({ dir })
    const r = store.save(def())
    expect(r.ok).toBe(true)
    expect(store.list()).toHaveLength(1)
    expect(store.get('researcher')).toMatchObject({ toolScope: 'peekaboo', maxIterations: 15 })
    expect(readFileSync(join(dir, 'researcher', 'AGENT.md'), 'utf8')).toContain('name: "Research Agent"')
  })

  it('rejects ids that violate the naming convention', () => {
    const store = createAgentStore({ dir })
    for (const id of ['Bad', 'with_underscore', '-leading', 'double--hyphen']) {
      expect(store.save(def({ id })).ok).toBe(false)
    }
  })

  it('removes an agent and returns the updated list', () => {
    const store = createAgentStore({ dir })
    store.save(def({ id: 'a' }))
    store.save(def({ id: 'b' }))
    const r = store.remove('a')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.agents.map((a) => a.id)).toEqual(['b'])
    expect(store.get('a')).toBeUndefined()
  })

  it('reload picks up agents written to disk and skips malformed ones', () => {
    const store = createAgentStore({ dir })
    store.save(def({ id: 'persisted' }))
    mkdirSync(join(dir, 'broken'))
    writeFileSync(join(dir, 'broken', 'AGENT.md'), '---\nname: B\ntoolScope: nope\n---\nbody')
    const fresh = createAgentStore({ dir })
    expect(fresh.list().map((a) => a.id)).toEqual(['persisted'])
  })

  const builtin = def({ id: 'researcher', systemPrompt: 'built-in body' })

  it('always lists and resolves built-in agents', () => {
    const store = createAgentStore({ dir, builtins: [builtin] })
    expect(store.list().map((a) => a.id)).toEqual(['researcher'])
    expect(store.get('researcher')?.systemPrompt).toBe('built-in body')
  })

  it('cannot remove a built-in (no on-disk folder)', () => {
    const store = createAgentStore({ dir, builtins: [builtin] })
    expect(store.remove('researcher').ok).toBe(false)
    expect(store.get('researcher')).toBeDefined()
  })

  it('a user agent of the same id overrides its built-in', () => {
    const store = createAgentStore({ dir, builtins: [builtin] })
    store.save(def({ id: 'researcher', systemPrompt: 'user body' }))
    expect(store.list().filter((a) => a.id === 'researcher')).toHaveLength(1)
    expect(store.get('researcher')?.systemPrompt).toBe('user body')
  })
})
