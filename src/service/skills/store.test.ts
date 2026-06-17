import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSkillStore, parseSkill, serializeSkill } from './store'

describe('parseSkill', () => {
  it('parses frontmatter name + description and body', () => {
    const raw = '---\nname: release-notes\ndescription: Draft release notes\n---\n\n## Steps\n1. do it'
    const skill = parseSkill(raw, 'fallback')
    expect(skill).toEqual({ name: 'release-notes', description: 'Draft release notes', body: '## Steps\n1. do it' })
  })

  it('falls back to the folder name when frontmatter is missing', () => {
    const skill = parseSkill('just a body', 'my-skill')
    expect(skill).toMatchObject({ name: 'my-skill', description: 'my-skill', body: 'just a body' })
  })

  it('round-trips through serializeSkill', () => {
    const skill = { name: 'x', description: 'd', body: 'b' }
    expect(parseSkill(serializeSkill(skill), 'fallback')).toEqual(skill)
  })

  it('round-trips the disable-model-invocation flag', () => {
    const skill = { name: 'x', description: 'd', body: 'b', disableModelInvocation: true }
    expect(parseSkill(serializeSkill(skill), 'fallback')).toEqual(skill)
  })

  it('parses descriptions containing colons via real YAML', () => {
    const raw = '---\nname: x\ndescription: "Draft: a thing, with commas"\n---\n\nbody'
    expect(parseSkill(raw, 'fallback')).toMatchObject({ description: 'Draft: a thing, with commas' })
  })
})

describe('createSkillStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarm-skills-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('saves a skill to <dir>/<name>/SKILL.md and lists it', () => {
    const store = createSkillStore({ dir })
    const r = store.save({ name: 'greet', description: 'say hi', body: 'Say hello.' })
    expect(r.ok).toBe(true)
    expect(store.list()).toHaveLength(1)
    expect(store.get('greet')).toMatchObject({ description: 'say hi', body: 'Say hello.' })
    expect(readFileSync(join(dir, 'greet', 'SKILL.md'), 'utf8')).toContain('name: greet')
  })

  it('rejects names that violate pi conventions', () => {
    const store = createSkillStore({ dir })
    for (const name of ['bad name!', 'Upper', 'with_underscore', '-leading', 'double--hyphen']) {
      expect(store.save({ name, description: 'd', body: '' }).ok).toBe(false)
    }
  })

  it('populates filePath on load', () => {
    const store = createSkillStore({ dir })
    store.save({ name: 'greet', description: 'd', body: 'b' })
    expect(store.get('greet')?.filePath).toBe(join(dir, 'greet', 'SKILL.md'))
  })

  it('removes a skill and returns the updated list', () => {
    const store = createSkillStore({ dir })
    store.save({ name: 'a', description: 'a', body: '' })
    store.save({ name: 'b', description: 'b', body: '' })
    const r = store.remove('a')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.skills.map((s) => s.name)).toEqual(['b'])
    expect(store.get('a')).toBeUndefined()
  })

  it('reload picks up skills written to disk', () => {
    const store = createSkillStore({ dir })
    store.save({ name: 'persisted', description: 'd', body: 'b' })
    const fresh = createSkillStore({ dir })
    expect(fresh.list().map((s) => s.name)).toEqual(['persisted'])
  })

  const builtin = { name: 'ops', description: 'manual', body: 'built-in body' }

  it('always lists and resolves built-in skills', () => {
    const store = createSkillStore({ dir, builtins: [builtin] })
    expect(store.list().map((s) => s.name)).toEqual(['ops'])
    expect(store.get('ops')?.body).toBe('built-in body')
  })

  it('cannot remove a built-in (no on-disk folder)', () => {
    const store = createSkillStore({ dir, builtins: [builtin] })
    expect(store.remove('ops').ok).toBe(false)
    expect(store.get('ops')).toBeDefined()
  })

  it('a user skill of the same name overrides its built-in', () => {
    const store = createSkillStore({ dir, builtins: [builtin] })
    store.save({ name: 'ops', description: 'user', body: 'user body' })
    expect(store.list().filter((s) => s.name === 'ops')).toHaveLength(1)
    expect(store.get('ops')?.body).toBe('user body')
  })
})
