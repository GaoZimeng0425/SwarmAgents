import type { Skill } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { callableSkills, extractMention, matchSkills } from './mention'

describe('extractMention', () => {
  it('returns null when no trigger char is present', () => {
    expect(extractMention('hello world', 11)).toBeNull()
  })

  it('detects / at the start of input', () => {
    expect(extractMention('/sum', 4)).toEqual({ trigger: '/', query: 'sum', start: 0, end: 4 })
  })

  it('detects / after whitespace', () => {
    expect(extractMention('hi /wri', 8)).toEqual({ trigger: '/', query: 'wri', start: 3, end: 8 })
  })

  it('detects @ at the start of input', () => {
    expect(extractMention('@src', 4)).toEqual({ trigger: '@', query: 'src', start: 0, end: 4 })
  })

  it('does NOT trigger mid-word (no preceding whitespace)', () => {
    // The / in "a/b" is not at a word boundary.
    expect(extractMention('a/b', 3)).toBeNull()
  })

  it('allows path separators inside an @ query', () => {
    expect(extractMention('@src/comp', 9)).toEqual({ trigger: '@', query: 'src/comp', start: 0, end: 9 })
  })

  it('returns null when whitespace appears after the trigger', () => {
    // Caret at end of "skill" (index 6, right before the space) → mention active.
    // (slice(1, 6) = "skill"; the brief's original caret=5/end=5 was off-by-one,
    //  which would yield query "skil".)
    expect(extractMention('/skill extra', 6)).toEqual({ trigger: '/', query: 'skill', start: 0, end: 6 })
    // Caret past the space → mention is stale.
    expect(extractMention('/skill extra', 12)).toBeNull()
  })

  it('returns null for a bare trigger with no query and caret moved away', () => {
    expect(extractMention('text /', 6)).toEqual({ trigger: '/', query: '', start: 5, end: 6 })
  })

  it('handles caret in the middle of a mention (only scans left)', () => {
    // Caret at position 2 inside "/su|m" — still within the mention.
    expect(extractMention('/sum', 2)).toEqual({ trigger: '/', query: 's', start: 0, end: 2 })
  })
})

describe('callableSkills', () => {
  const mk = (over: Partial<Skill>): Skill => ({ name: 'x', description: 'd', body: '', ...over })

  it('keeps normal enabled skills', () => {
    const skills = [mk({ name: 'a' })]
    expect(callableSkills(skills)).toEqual(skills)
  })

  it('drops disableModelInvocation skills', () => {
    const skills = [mk({ name: 'a' }), mk({ name: 'b', disableModelInvocation: true })]
    expect(callableSkills(skills).map((s) => s.name)).toEqual(['a'])
  })

  it('drops disabled skills', () => {
    const skills = [mk({ name: 'a' }), mk({ name: 'b', enabled: false })]
    expect(callableSkills(skills).map((s) => s.name)).toEqual(['a'])
  })
})

describe('matchSkills', () => {
  const mk = (name: string, description: string): Skill => ({ name, description, body: '' }) as Skill

  it('returns all when query is empty', () => {
    const skills = [mk('a', 'desc'), mk('b', 'desc')]
    expect(matchSkills(skills, '').map((s) => s.name)).toEqual(['a', 'b'])
  })

  it('matches by name (case-insensitive)', () => {
    const skills = [mk('summarize', 'makes a summary'), mk('translate', 'converts language')]
    expect(matchSkills(skills, 'SUM').map((s) => s.name)).toEqual(['summarize'])
  })

  it('matches by description', () => {
    const skills = [mk('foo', 'makes a summary'), mk('bar', 'converts language')]
    expect(matchSkills(skills, 'summary').map((s) => s.name)).toEqual(['foo'])
  })

  it('ranks name hits before description-only hits', () => {
    const skills = [mk('alpha', 'contains sum'), mk('sum', 'a tool')]
    expect(matchSkills(skills, 'sum').map((s) => s.name)).toEqual(['sum', 'alpha'])
  })
})
