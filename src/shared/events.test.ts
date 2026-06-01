import { describe, expect, it, vi } from 'vitest'

import { createEventBus, type DomainEvent, getEventBus, initEventBus, resetEventBus } from './events'

describe('createEventBus', () => {
  it('delivers events to matching subscribers', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    bus.subscribe('task.complete', handler)

    const event: DomainEvent & { type: 'task.complete' } = {
      type: 'task.complete',
      taskId: 't1',
      result: { summary: 'done', artifacts: [] },
      ts: 1000,
    }
    bus.publish(event)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('does not deliver to non-matching subscribers', () => {
    const bus = createEventBus()
    const completeHandler = vi.fn()
    const errorHandler = vi.fn()

    bus.subscribe('task.complete', completeHandler)
    bus.subscribe('task.error', errorHandler)

    bus.publish({
      type: 'task.complete',
      taskId: 't1',
      result: { summary: 'done', artifacts: [] },
      ts: 1000,
    })

    expect(completeHandler).toHaveBeenCalledOnce()
    expect(errorHandler).not.toHaveBeenCalled()
  })

  it('unsubscribe stops delivery', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    const handle = bus.subscribe('task.complete', handler)

    handle.unsubscribe()

    bus.publish({
      type: 'task.complete',
      taskId: 't1',
      result: { summary: 'done', artifacts: [] },
      ts: 1000,
    })

    expect(handler).not.toHaveBeenCalled()
  })

  it('subscribeAll receives all event types', () => {
    const bus = createEventBus()
    const allHandler = vi.fn()
    bus.subscribeAll(allHandler)

    bus.publish({
      type: 'task.complete',
      taskId: 't1',
      result: { summary: 'done', artifacts: [] },
      ts: 1000,
    })
    bus.publish({
      type: 'task.error',
      taskId: 't2',
      error: { code: 'x', message: 'fail', tier: 'fatal' },
      ts: 2000,
    })

    expect(allHandler).toHaveBeenCalledTimes(2)
  })

  it('subscribeAll unsubscribe stops delivery', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    const handle = bus.subscribeAll(handler)
    handle.unsubscribe()

    bus.publish({
      type: 'task.complete',
      taskId: 't1',
      result: { summary: 'done', artifacts: [] },
      ts: 1000,
    })

    expect(handler).not.toHaveBeenCalled()
  })

  it('dispose clears all subscriptions', () => {
    const bus = createEventBus()
    const h1 = vi.fn()
    const h2 = vi.fn()
    bus.subscribe('task.complete', h1)
    bus.subscribeAll(h2)

    bus.dispose()

    bus.publish({
      type: 'task.complete',
      taskId: 't1',
      result: { summary: 'done', artifacts: [] },
      ts: 1000,
    })

    expect(h1).not.toHaveBeenCalled()
    expect(h2).not.toHaveBeenCalled()
  })

  it('delivers to multiple subscribers of the same type', () => {
    const bus = createEventBus()
    const h1 = vi.fn()
    const h2 = vi.fn()
    bus.subscribe('task.complete', h1)
    bus.subscribe('task.complete', h2)

    bus.publish({
      type: 'task.complete',
      taskId: 't1',
      result: { summary: 'done', artifacts: [] },
      ts: 1000,
    })

    expect(h1).toHaveBeenCalledOnce()
    expect(h2).toHaveBeenCalledOnce()
  })
})

describe('event bus singleton', () => {
  it('initEventBus creates singleton', () => {
    resetEventBus()
    const bus = initEventBus()
    expect(bus).toBeDefined()
    expect(getEventBus()).toBe(bus)
    resetEventBus()
  })

  it('initEventBus returns same instance on repeated calls', () => {
    resetEventBus()
    const a = initEventBus()
    const b = initEventBus()
    expect(a).toBe(b)
    resetEventBus()
  })

  it('getEventBus returns null before init', () => {
    resetEventBus()
    expect(getEventBus()).toBeNull()
  })
})
