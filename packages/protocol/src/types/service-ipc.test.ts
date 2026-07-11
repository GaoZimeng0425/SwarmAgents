import { describe, expect, it } from 'vitest'

import type { MainMethod, RpcMessage, RpcMethod, RpcRequest, RpcResponse, ServiceMethod } from './service-ipc'

describe('service-ipc unified rpc types', () => {
  it('an RpcRequest carries a ServiceMethod or a MainMethod', () => {
    const service: RpcRequest = { kind: 'request', id: 'a:1', method: 'listAgents', args: [] }
    const main: RpcRequest = { kind: 'request', id: 'b:1', method: 'weather.get_forecast', args: [null, null] }
    expect(service.method).toBe('listAgents')
    expect(main.method).toBe('weather.get_forecast')
  })

  it('RpcResponse is discriminated on ok', () => {
    const ok: RpcResponse = { kind: 'response', id: 'a:1', ok: true, result: [] }
    const bad: RpcResponse = { kind: 'response', id: 'a:2', ok: false, error: 'boom' }
    expect(ok.ok).toBe(true)
    expect(bad.ok).toBe(false)
  })

  it('RpcRequest and RpcResponse are both valid RpcMessage values', () => {
    const req: RpcMessage = { kind: 'request', id: 'a:1', method: 'gmail.search', args: ['x', 10] }
    const res: RpcMessage = { kind: 'response', id: 'a:1', ok: true, result: 1 }
    expect(req.kind).toBe('request')
    expect(res.kind).toBe('response')
  })

  it('RpcMethod accepts both ServiceMethod and MainMethod values', () => {
    const a: RpcMethod = 'submitPrompt'
    const b: RpcMethod = 'calendar.list_upcoming'
    expect(a).toBe('submitPrompt')
    expect(b).toBe('calendar.list_upcoming')
  })
})
