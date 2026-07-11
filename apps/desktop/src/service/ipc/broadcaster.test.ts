import { describe, expect, it, vi } from 'vitest'

import { createBroadcaster } from './broadcaster'

describe('broadcaster', () => {
  it('forwards broadcasts to the sink', () => {
    const sink = vi.fn()
    const b = createBroadcaster(sink)
    b.broadcast('message.complete', { messageId: 'x' })
    expect(sink).toHaveBeenCalledWith('message.complete', { messageId: 'x' })
  })

  it('defaults to a no-op sink', () => {
    const b = createBroadcaster()
    expect(() => b.broadcast('message.progress', { messageId: 'y' })).not.toThrow()
  })
})
