// src/service/actor-mailbox.test.ts

import type { ActorMessage } from '@shared/types/actor'
import { describe, expect, it, vi } from 'vitest'

import { createMailbox, IdleTimeoutError } from './actor-mailbox'

const msg = (id: string): ActorMessage => ({
  id,
  toAddr: 'a',
  fromAddr: null,
  kind: 'send',
  correlationId: null,
  payload: '{}',
  consumed: false,
  retries: 0,
  dead: false,
  ts: 1,
})

describe('createMailbox', () => {
  it('returns an already-queued message immediately', async () => {
    const mb = createMailbox()
    mb.deliver(msg('m1'))
    expect((await mb.receive({ idleMs: 1000 })).id).toBe('m1')
  })

  it('blocks until a message is delivered, then resolves it', async () => {
    const mb = createMailbox()
    const p = mb.receive({ idleMs: 1000 })
    mb.deliver(msg('m2'))
    expect((await p).id).toBe('m2')
  })

  it('rejects with IdleTimeoutError when no message arrives in idleMs', async () => {
    vi.useFakeTimers()
    const mb = createMailbox()
    const p = mb.receive({ idleMs: 50 })
    const assertion = expect(p).rejects.toBeInstanceOf(IdleTimeoutError)
    await vi.advanceTimersByTimeAsync(60)
    await assertion
    vi.useRealTimers()
  })

  it('delivers in FIFO order', async () => {
    const mb = createMailbox()
    mb.deliver(msg('m1'))
    mb.deliver(msg('m2'))
    expect((await mb.receive({ idleMs: 1000 })).id).toBe('m1')
    expect((await mb.receive({ idleMs: 1000 })).id).toBe('m2')
  })
})
