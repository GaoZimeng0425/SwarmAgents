import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { describe, expect, it } from 'vitest'

import { ACTOR_STATE_VERSION, decodeActorState, encodeActorState } from './actor-state'

const sample = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
] as unknown as AgentMessage[]

describe('actor-state codec', () => {
  it('round-trips messages through encode/decode', () => {
    const blob = encodeActorState(sample)
    expect(JSON.parse(blob)).toEqual({ v: ACTOR_STATE_VERSION, messages: sample })
    expect(decodeActorState(blob)).toEqual(sample)
  })

  it('decodes null to empty history', () => {
    expect(decodeActorState(null)).toEqual([])
  })

  it('decodes malformed JSON to empty history without throwing', () => {
    expect(decodeActorState('{not json')).toEqual([])
  })

  it('decodes a version mismatch to empty history', () => {
    const stale = JSON.stringify({ v: 999, messages: sample })
    expect(decodeActorState(stale)).toEqual([])
  })

  it('decodes a blob missing messages to empty history', () => {
    const bad = JSON.stringify({ v: ACTOR_STATE_VERSION })
    expect(decodeActorState(bad)).toEqual([])
  })
})
