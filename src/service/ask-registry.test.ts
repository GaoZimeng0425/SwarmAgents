import { describe, expect, it, vi } from 'vitest'

import { createAskRegistry } from './ask-registry'

describe('AskRegistry', () => {
  it('broadcasts task.ask on request and resolves with the chosen answer', async () => {
    const broadcast = vi.fn()
    const registry = createAskRegistry(broadcast)

    const promise = registry.request({
      taskId: 'task-1',
      question: 'Which option?',
      options: [{ label: 'A' }, { label: 'B', value: 'b' }],
      mode: 'single',
    })

    expect(broadcast).toHaveBeenCalledOnce()
    const [event, data] = broadcast.mock.calls[0] as [string, { askId: string; question: string }]
    expect(event).toBe('task.ask')
    expect(data.askId).toBeTruthy()
    expect(data.question).toBe('Which option?')

    registry.resolve(data.askId, 'b')
    await expect(promise).resolves.toBe('b')
  })

  it('ignores resolve for unknown askId', () => {
    const registry = createAskRegistry(vi.fn())
    expect(() => registry.resolve('unknown', 'x')).not.toThrow()
  })

  it('cancelAll resolves every pending ask with the reason', async () => {
    const registry = createAskRegistry(vi.fn())
    const a = registry.request({ taskId: 't', question: 'q1', options: [{ label: 'x' }], mode: 'single' })
    const b = registry.request({ taskId: 't', question: 'q2', options: [{ label: 'y' }], mode: 'single' })

    registry.cancelAll('Cancelled by user.')
    await expect(a).resolves.toBe('Cancelled by user.')
    await expect(b).resolves.toBe('Cancelled by user.')
  })
})
