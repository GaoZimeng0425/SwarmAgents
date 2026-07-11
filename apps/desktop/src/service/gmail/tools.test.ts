import { describe, expect, it, vi } from 'vitest'

import { gmailSpecs } from './tools'

describe('gmail tools', () => {
  it('search returns formatted rows and details', async () => {
    const callMain = vi.fn(async () => [
      { id: 't1', snippet: 'inv', fromAddr: 'a@b', subject: 'Inv', lastDateMs: 1, labelIds: ['INBOX'], unread: true },
    ])
    const spec = gmailSpecs(callMain).find((s) => s.name === 'search')!
    const tool = spec.build({} as never)
    const out = (await tool.execute('id1', { query: 'inv' })) as {
      content: { text: string }[]
      details: { count: number }
    }
    expect(callMain).toHaveBeenCalledWith('gmail.search', ['inv', 20])
    expect(out.details.count).toBe(1)
    expect(out.content[0].text).toContain('Inv')
  })

  it('search errors on empty query', async () => {
    const callMain = vi.fn(async () => [])
    const spec = gmailSpecs(callMain).find((s) => s.name === 'search')!
    const tool = spec.build({} as never)
    const out = (await tool.execute('id1', { query: '' })) as { details: { error: string } }
    expect(out.details.error).toBeTruthy()
    expect(callMain).not.toHaveBeenCalled()
  })

  it('get_thread calls gmail.get_thread with id', async () => {
    const callMain = vi.fn(async () => ({ thread: { id: 't1' }, messages: [] }))
    const spec = gmailSpecs(callMain).find((s) => s.name === 'get_thread')!
    await spec.build({} as never).execute('id1', { id: 't1' })
    expect(callMain).toHaveBeenCalledWith('gmail.get_thread', ['t1'])
  })

  it('list_recent passes limit + label', async () => {
    const callMain = vi.fn(async () => [])
    const spec = gmailSpecs(callMain).find((s) => s.name === 'list_recent')!
    await spec.build({} as never).execute('id1', { limit: 5, label: 'INBOX' })
    expect(callMain).toHaveBeenCalledWith('gmail.list_recent', [{ limit: 5, label: 'INBOX' }])
  })

  it('surfaces main-rpc errors as tool errors', async () => {
    const callMain = vi.fn(async () => {
      throw new Error('boom')
    })
    const spec = gmailSpecs(callMain).find((s) => s.name === 'list_recent')!
    const out = (await spec.build({} as never).execute('id1', {})) as { details: { error: string } }
    expect(out.details.error).toContain('boom')
  })
})
