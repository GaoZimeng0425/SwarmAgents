import { describe, expect, it } from 'vitest'

import type { ServiceMethod } from './service-methods'
import { serviceMethodArgSchemas } from './service-methods'

describe('serviceMethodArgSchemas', () => {
  it('covers exactly the 45 service methods', () => {
    expect(Object.keys(serviceMethodArgSchemas)).toHaveLength(45)
  })

  it('accepts a full-arity call', () => {
    const r = serviceMethodArgSchemas.renameSession.safeParse(['s1', 'new title'])
    expect(r.success).toBe(true)
  })

  it('accepts omitted trailing optionals (short array)', () => {
    expect(serviceMethodArgSchemas.getSessionEntries.safeParse(['s1']).success).toBe(true)
    expect(serviceMethodArgSchemas.submitPrompt.safeParse(['s1', 'hello']).success).toBe(true)
    expect(serviceMethodArgSchemas.listMemory.safeParse([]).success).toBe(true)
  })

  it('accepts explicit undefined in optional slots', () => {
    expect(serviceMethodArgSchemas.getSessionEntries.safeParse(['s1', undefined]).success).toBe(true)
  })

  it('rejects wrong arity and wrong types', () => {
    expect(serviceMethodArgSchemas.renameSession.safeParse(['s1']).success).toBe(false)
    expect(serviceMethodArgSchemas.renameSession.safeParse([1, 2]).success).toBe(false)
    expect(serviceMethodArgSchemas.getSessionEntries.safeParse(['s1', 'not-a-number']).success).toBe(false)
  })

  it('rejects malformed complex objects', () => {
    expect(serviceMethodArgSchemas.saveAgent.safeParse([{ id: 'Bad Id!' }]).success).toBe(false)
    expect(serviceMethodArgSchemas.decidePermission.safeParse(['s1', 'a1', 'nope']).success).toBe(false)
  })

  it('accepts a valid mutating complex object', () => {
    const def = {
      id: 'my-agent',
      name: 'My Agent',
      description: 'Use when testing.',
      systemPrompt: 'x',
      maxIterations: 25,
    }
    expect(serviceMethodArgSchemas.saveAgent.safeParse([def]).success).toBe(true)
  })

  it('every method name round-trips as a ServiceMethod', () => {
    const methods = Object.keys(serviceMethodArgSchemas) as ServiceMethod[]
    expect(methods).toContain('submitPrompt')
    expect(methods).toContain('forkSession')
  })
})
