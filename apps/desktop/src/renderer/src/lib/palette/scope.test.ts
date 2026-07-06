// apps/desktop/src/renderer/src/lib/palette/scope.test.ts
import { describe, expect, it } from 'vitest'

import { getScope, SCOPE_META } from './scope'

describe('getScope', () => {
  it('detects the command prefix ">"', () => {
    expect(getScope('>settings')).toEqual({ mode: 'command', term: 'settings' })
    expect(getScope('>')).toEqual({ mode: 'command', term: '' })
  })
  it('detects the agent prefix "@"', () => {
    expect(getScope('@research')).toEqual({ mode: 'agent', term: 'research' })
  })
  it('detects the task prefix "#"', () => {
    expect(getScope('#running')).toEqual({ mode: 'task', term: 'running' })
  })
  it('detects the file prefix "/"', () => {
    expect(getScope('/readme')).toEqual({ mode: 'file', term: 'readme' })
  })
  it('falls back to mixed when no prefix', () => {
    expect(getScope('hello')).toEqual({ mode: 'mixed', term: 'hello' })
    expect(getScope('')).toEqual({ mode: 'mixed', term: '' })
  })
  it('treats a lone space or non-prefix char as mixed', () => {
    expect(getScope(' !')).toEqual({ mode: 'mixed', term: '!' })
    expect(getScope('  ')).toEqual({ mode: 'mixed', term: '' })
  })
  it('trims the term and collapses internal whitespace (kept as-is)', () => {
    // We only trim the term; internal spaces are the user's query.
    expect(getScope('>  new chat  ')).toEqual({ mode: 'command', term: 'new chat' })
  })
})

describe('SCOPE_META', () => {
  it('has the four prefix scopes + mixed, each with pill/color/placeholder', () => {
    const modes = Object.keys(SCOPE_META).sort()
    expect(modes).toEqual(['agent', 'command', 'file', 'mixed', 'task'])
    expect(SCOPE_META.command.color).toBe('text-primary')
    expect(SCOPE_META.agent.color).toBe('text-indigo-500')
    expect(SCOPE_META.task.color).toBe('text-orange-500')
    expect(SCOPE_META.file.color).toBe('text-emerald-500')
    expect(SCOPE_META.mixed.pill).toBeNull()
    expect(SCOPE_META.command.pill).toBe('命令')
    expect(SCOPE_META.agent.pill).toBe('指派')
    expect(SCOPE_META.task.pill).toBe('任务')
    expect(SCOPE_META.file.pill).toBe('文件')
  })
})
