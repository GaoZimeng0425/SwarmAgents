import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDefinition } from '@swarm/protocol'
import { allowlistForAgent } from '@swarm/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAgentStore, parseAgent, serializeAgent, syncBuiltinAgents } from './store'

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

  it('round-trips parentId through serialize + parse', () => {
    const d = def({ id: 'engineer', parentId: 'pm' })
    expect(parseAgent(serializeAgent(d), d.id)).toEqual(d)
  })

  it('omits parentId from frontmatter when absent', () => {
    expect(serializeAgent(def())).not.toContain('parentId')
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

  it('old-style def (toolScope authoring, no flag) round-trips AND still resolves the privileged allowlist', () => {
    const store = createAgentStore({ dir })
    const legacy = def({ id: 'legacy-author', toolScope: 'authoring' })
    expect(store.save(legacy).ok).toBe(true)
    const parsed = createAgentStore({ dir }).get('legacy-author')
    expect(parsed).toBeDefined()
    expect(parsed?.toolScope).toBe('authoring')
    // Chain parse → privilege: the legacy scope alone must keep the authoring grant.
    expect(allowlistForAgent(parsed!)).toContain('authoring.*')
  })

  it('round-trips role, capabilities, team and teamRole through save + reload', () => {
    const store = createAgentStore({ dir })
    const d = {
      id: 'training-head',
      name: 'Training Lead',
      description: 'Use to coordinate the agent-training team.',
      systemPrompt: 'You lead the training team.',
      toolScope: 'authoring' as const,
      role: 'training-head',
      capabilities: ['agent-authoring', 'skill-authoring'],
      team: 'training',
      teamRole: 'head' as const,
      maxIterations: 20,
    }
    const res = store.save(d)
    expect(res.ok).toBe(true)
    store.reload()
    const got = store.get('training-head')
    expect(got).toMatchObject({
      role: 'training-head',
      capabilities: ['agent-authoring', 'skill-authoring'],
      team: 'training',
      teamRole: 'head',
    })
  })
})

describe('syncBuiltinAgents', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarm-agents-seed-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes one AGENT.md per def into an empty dir', () => {
    const { written } = syncBuiltinAgents(dir, [def({ id: 'a' }), def({ id: 'b' })])
    expect(written).toBe(2)
    expect(
      createAgentStore({ dir })
        .list()
        .map((x) => x.id)
        .sort()
    ).toEqual(['a', 'b'])
  })

  it('is idempotent — re-running with unchanged defs writes nothing', () => {
    syncBuiltinAgents(dir, [def({ id: 'a' })])
    const { written } = syncBuiltinAgents(dir, [def({ id: 'a' })])
    expect(written).toBe(0)
  })

  it('upserts a changed builtin and adds a new one, preserving user agents', () => {
    syncBuiltinAgents(dir, [def({ id: 'a', name: 'Old' })])
    createAgentStore({ dir }).save(def({ id: 'mine' })) // user-authored
    const { written } = syncBuiltinAgents(dir, [def({ id: 'a', name: 'New' }), def({ id: 'b' })])
    expect(written).toBe(2) // 'a' updated + 'b' added; 'mine' untouched
    const store = createAgentStore({ dir })
    expect(store.get('a')?.name).toBe('New')
    expect(
      store
        .list()
        .map((x) => x.id)
        .sort()
    ).toEqual(['a', 'b', 'mine'])
  })

  it('prunes a retired builtin folder but leaves user agents alone', () => {
    syncBuiltinAgents(dir, [def({ id: 'pm' }), def({ id: 'a' })])
    createAgentStore({ dir }).save(def({ id: 'pm-clone' }))
    const { removed } = syncBuiltinAgents(dir, [def({ id: 'a' })], ['pm'])
    expect(removed).toBe(1)
    expect(
      createAgentStore({ dir })
        .list()
        .map((x) => x.id)
        .sort()
    ).toEqual(['a', 'pm-clone'])
  })

  // Regression (Task-5 review): serializeAgent wrote `toolScope: undefined` for
  // defs without a toolScope, which parseAgent then rejected — the exact boot
  // sequence (syncBuiltinAgents → createAgentStore) silently wiped most of the
  // builtin roster once builtins dropped their toolScope strings.
  it('boot sequence survives a def without toolScope and preserves authoring: true', () => {
    const builtin: AgentDefinition = {
      id: 'training-author',
      name: 'Agent Author',
      description: 'Use to write agent/skill definitions to disk.',
      systemPrompt: 'You author agents.',
      authoring: true,
      maxIterations: 20,
    }
    syncBuiltinAgents(dir, [builtin])
    const store = createAgentStore({ dir })
    const got = store.get('training-author')
    expect(got).toBeDefined()
    expect(got?.authoring).toBe(true)
    expect(got?.toolScope).toBeUndefined()
  })
})

describe('save parentId validation', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agents-parent-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects an agent that is its own parent', () => {
    const store = createAgentStore({ dir })
    const res = store.save(def({ id: 'a', parentId: 'a' }))
    expect(res).toMatchObject({ ok: false, code: 'self_parent' })
  })

  it('rejects an unknown parent', () => {
    const store = createAgentStore({ dir })
    const res = store.save(def({ id: 'a', parentId: 'ghost' }))
    expect(res).toMatchObject({ ok: false, code: 'unknown_parent' })
  })

  it('rejects a parent cycle', () => {
    const store = createAgentStore({ dir })
    // a -> b exists on disk; saving b -> a closes the loop.
    expect(store.save(def({ id: 'b' })).ok).toBe(true)
    expect(store.save(def({ id: 'a', parentId: 'b' })).ok).toBe(true)
    const res = store.save(def({ id: 'b', parentId: 'a' }))
    expect(res).toMatchObject({ ok: false, code: 'cycle' })
  })

  it('accepts a valid parent', () => {
    const store = createAgentStore({ dir })
    expect(store.save(def({ id: 'pm' })).ok).toBe(true)
    expect(store.save(def({ id: 'engineer', parentId: 'pm' })).ok).toBe(true)
  })
})
