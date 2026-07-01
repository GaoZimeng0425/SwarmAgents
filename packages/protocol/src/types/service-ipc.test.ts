import { describe, expect, it } from 'vitest'

import type { MainRequest, MainResponse, MainToService, ServiceToMain } from './service-ipc'

describe('service-ipc main-rpc extension', () => {
  it('a MainRequest has kind mainRequest', () => {
    const m: MainRequest = { kind: 'mainRequest', id: 1, method: 'gmail.search', args: ['x', 10] }
    expect(m.kind).toBe('mainRequest')
    expect(m.method).toBe('gmail.search')
  })

  it('MainResponse discriminated on ok', () => {
    const ok: MainResponse = { kind: 'mainResponse', id: 1, ok: true, result: [] }
    const bad: MainResponse = { kind: 'mainResponse', id: 2, ok: false, error: 'boom' }
    expect(ok.ok).toBe(true)
    expect(bad.ok).toBe(false)
  })

  it('MainRequest is a valid ServiceToMain message', () => {
    const m: ServiceToMain = { kind: 'mainRequest', id: 1, method: 'gmail.list_recent', args: [] }
    expect(m.kind).toBe('mainRequest')
  })

  it('MainResponse is a valid MainToService message', () => {
    const m: MainToService = { kind: 'mainResponse', id: 1, ok: true, result: 1 }
    expect(m.kind).toBe('mainResponse')
  })
})
