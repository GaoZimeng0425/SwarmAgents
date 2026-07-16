import { describe, expect, it } from 'vitest'

import { DelegationItemSchema } from './delegation'

describe('delegation plan schemas', () => {
  it('parses a minimal item and defaults dependsOn to []', () => {
    const item = DelegationItemSchema.parse({ id: 'd1', prompt: 'do X' })
    expect(item.dependsOn).toEqual([])
    expect(item.ownerAgentType).toBeUndefined()
  })

  it('parses a full item with owner and dependsOn', () => {
    const item = DelegationItemSchema.parse({
      id: 'd2',
      prompt: 'do Y',
      ownerAgentType: 'engineer',
      dependsOn: ['d1'],
    })
    expect(item.dependsOn).toEqual(['d1'])
  })
})
