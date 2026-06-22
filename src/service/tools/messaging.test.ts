import { describe, expect, it, vi } from 'vitest'

import { sendAndWaitSpec, sendMessageSpec, whoamiSpec } from './messaging'

const ctx = (over: Partial<any> = {}) =>
  ({
    selfAddress: 'me',
    sendMessage: vi.fn(async () => {}),
    sendAndWait: vi.fn(async () => 'the-reply'),
    ...over,
  }) as any

describe('messaging tools', () => {
  it('send_message calls ctx.sendMessage and reports delivery', async () => {
    const c = ctx()
    const tool = sendMessageSpec().build(c)
    const res = await tool.execute('id', { to: 'peer', payload: 'hi' })
    expect(c.sendMessage).toHaveBeenCalledWith('peer', 'hi')
    expect(res.content[0].text).toMatch(/delivered/i)
  })

  it('send_and_wait returns the reply text', async () => {
    const c = ctx()
    const tool = sendAndWaitSpec().build(c)
    const res = await tool.execute('id', { to: 'peer', payload: 'ping' })
    expect(c.sendAndWait).toHaveBeenCalledWith('peer', 'ping')
    expect(res.content[0].text).toBe('the-reply')
  })

  it('whoami returns the agent self address', async () => {
    const tool = whoamiSpec().build(ctx())
    const res = await tool.execute('id', {})
    expect(res.content[0].text).toContain('me')
  })

  it('whoami returns the fallback when selfAddress is absent', async () => {
    const tool = whoamiSpec().build(ctx({ selfAddress: undefined }))
    const res = await tool.execute('id', {})
    expect(res.content[0].text).toContain('no address: this agent is not addressable')
  })
})
