import { describe, expect, it } from 'vitest'

import { abortableDelay, decideNextAttempt, isPermanentModelFailure } from './retry'

describe('decideNextAttempt — mirrors the v1 promptOnce loop semantics', () => {
  const base = { attempt: 0, maxRetries: 2, modelIdx: 0, chainLength: 2, permanent: false }

  it('retries the same model while transient attempts remain', () => {
    expect(decideNextAttempt({ ...base })).toBe('retry-same-model')
    expect(decideNextAttempt({ ...base, attempt: 1 })).toBe('retry-same-model')
  })

  it('advances to the next model when retries are exhausted', () => {
    expect(decideNextAttempt({ ...base, attempt: 2 })).toBe('advance-model')
  })

  it('advances immediately on a permanent failure, without burning retries', () => {
    expect(decideNextAttempt({ ...base, permanent: true })).toBe('advance-model')
  })

  it('gives up when the last model exhausts its retries', () => {
    expect(decideNextAttempt({ ...base, attempt: 2, modelIdx: 1 })).toBe('give-up')
  })

  it('gives up on a permanent failure on the last model', () => {
    expect(decideNextAttempt({ ...base, permanent: true, modelIdx: 1 })).toBe('give-up')
  })

  it('single-model chain: retry then give-up, never advance', () => {
    expect(decideNextAttempt({ ...base, chainLength: 1 })).toBe('retry-same-model')
    expect(decideNextAttempt({ ...base, chainLength: 1, attempt: 2 })).toBe('give-up')
    expect(decideNextAttempt({ ...base, chainLength: 1, permanent: true })).toBe('give-up')
  })
})

describe('isPermanentModelFailure', () => {
  it.each([
    '401 Unauthorized',
    'invalid api key',
    'invalid_api_key provided',
    'model not found',
    'No such model: x',
    'insufficient_quota',
    'billing hard limit',
    'permission denied',
    '404',
  ])('treats %s as permanent', (msg) => expect(isPermanentModelFailure(msg)).toBe(true))

  it.each([
    '503 Service Unavailable',
    'connection reset',
    'timeout awaiting response',
    'rate limited, retry soon',
    'overloaded_error',
  ])('treats %s as transient', (msg) => expect(isPermanentModelFailure(msg)).toBe(false))
})

describe('abortableDelay', () => {
  it('resolves immediately when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const t0 = Date.now()
    await abortableDelay(60_000, ac.signal)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it('resolves early when the signal fires during the wait', async () => {
    const ac = new AbortController()
    const t0 = Date.now()
    const p = abortableDelay(60_000, ac.signal)
    setTimeout(() => ac.abort(), 10)
    await p
    expect(Date.now() - t0).toBeLessThan(5_000)
  })
})
