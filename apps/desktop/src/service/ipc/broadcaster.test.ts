import { describe, expect, it, vi } from 'vitest'

import { createBroadcaster } from './broadcaster'

describe('broadcaster', () => {
  it('forwards broadcasts to the sink', () => {
    const sink = vi.fn()
    const b = createBroadcaster(sink)
    b.broadcast('task.complete', { taskId: 'x' })
    expect(sink).toHaveBeenCalledWith('task.complete', { taskId: 'x' })
  })

  it('defaults to a no-op sink', () => {
    const b = createBroadcaster()
    expect(() => b.broadcast('task.progress', { taskId: 'y' })).not.toThrow()
  })
})
