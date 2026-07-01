// src/shared/types/actor.test.ts
import { describe, expect, it } from 'vitest'
import { MessageKindSchema } from './actor'

describe('actor types', () => {
  it('MessageKindSchema accepts send and rpc, rejects others', () => {
    expect(MessageKindSchema.parse('send')).toBe('send')
    expect(MessageKindSchema.parse('rpc')).toBe('rpc')
    expect(MessageKindSchema.safeParse('broadcast').success).toBe(false)
  })
})
