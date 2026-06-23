import { afterEach, describe, expect, it, vi } from 'vitest'

import { createReplyRegistry } from './reply-registry'

describe('createReplyRegistry', () => {
  afterEach(() => vi.useRealTimers())

  it('resolve wakes a pending awaitReply with the payload', async () => {
    const r = createReplyRegistry()
    const p = r.awaitReply('c1', 1000)
    r.resolve('c1', 'the-reply')
    expect(await p).toBe('the-reply')
  })

  it('awaitReply resolves to empty string on timeout', async () => {
    vi.useFakeTimers()
    const r = createReplyRegistry()
    const p = r.awaitReply('c2', 50)
    await vi.advanceTimersByTimeAsync(60)
    expect(await p).toBe('')
  })

  it('resolve for an unknown correlationId is a no-op (does not throw)', () => {
    const r = createReplyRegistry()
    expect(() => r.resolve('ghost', 'x')).not.toThrow()
  })

  it('a resolved correlationId only fires once', async () => {
    const r = createReplyRegistry()
    const p = r.awaitReply('c3', 1000)
    r.resolve('c3', 'first')
    r.resolve('c3', 'second') // no pending waiter anymore — ignored
    expect(await p).toBe('first')
  })
})
