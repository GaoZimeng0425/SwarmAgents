import { describe, expect, it, vi } from 'vitest'

import { createBroadcaster } from './broadcaster'

describe('broadcaster', () => {
  it('forwards broadcasts to the sink', () => {
    const sink = vi.fn()
    const b = createBroadcaster(sink)
    b.broadcast('run.complete', { runId: 'x' })
    expect(sink).toHaveBeenCalledWith('run.complete', { runId: 'x' })
  })

  it('defaults to a no-op sink', () => {
    const b = createBroadcaster()
    expect(() => b.broadcast('run.progress', { runId: 'y' })).not.toThrow()
  })
})
