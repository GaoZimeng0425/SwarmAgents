import { describe, expect, it, vi } from 'vitest'

import { createBroadcaster } from './broadcaster'

describe('broadcaster', () => {
  it('forwards broadcasts to the sink', () => {
    const sink = vi.fn()
    const b = createBroadcaster(sink)
    b.broadcast('agent_end', { messageId: 'x' })
    expect(sink).toHaveBeenCalledWith('agent_end', { messageId: 'x' })
  })

  it('defaults to a no-op sink', () => {
    const b = createBroadcaster()
    expect(() => b.broadcast('turn_end', { messageId: 'y' })).not.toThrow()
  })
})
