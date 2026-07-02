import type { MainMethod } from '@swarm/protocol'
import { describe, expect, it, vi } from 'vitest'

import { calendarSpecs } from './tools'

type MainRpcFn = (method: MainMethod, args: unknown[]) => Promise<unknown>

describe('calendar tools', () => {
  it('exposes exactly the 5 calendar tools with the right group/risk', () => {
    const specs = calendarSpecs(vi.fn(async () => []) as MainRpcFn)
    expect(specs.map((s) => s.name)).toEqual([
      'list_upcoming',
      'get_event',
      'create_local',
      'update_local',
      'delete_local',
    ])
    for (const s of specs) expect(s.group).toBe('calendar')
    expect(specs.find((s) => s.name === 'list_upcoming')?.risk).toBe('low')
    expect(specs.find((s) => s.name === 'create_local')?.risk).toBe('medium')
  })

  it('list_upcoming renders events returned by mainRpc', async () => {
    const mainRpc = vi.fn(async () => [
      { title: 'Standup', startMs: 1000, endMs: 2000, location: 'Zoom', source: 'google' },
    ]) as unknown as MainRpcFn
    const spec = calendarSpecs(mainRpc).find((s) => s.name === 'list_upcoming')!
    const out = (await spec.build({} as never).execute('id', { days: 7 })) as {
      content: { text: string }[]
      details: { count: number }
    }
    expect(mainRpc).toHaveBeenCalledWith('calendar.list_upcoming', [7])
    expect(out.details.count).toBe(1)
    expect(out.content[0].text).toContain('Standup')
  })

  it('create_local forwards the input', async () => {
    const mainRpc = vi.fn(async () => ({ id: 'x', title: 'M', source: 'local' })) as unknown as MainRpcFn
    const spec = calendarSpecs(mainRpc).find((s) => s.name === 'create_local')!
    await spec.build({} as never).execute('id', { title: 'M', startMs: 1, endMs: 2 })
    expect(mainRpc).toHaveBeenCalledWith('calendar.create_local', [{ title: 'M', startMs: 1, endMs: 2 }])
  })

  it('delete_local forwards id and reports deletion', async () => {
    const mainRpc = vi.fn(async () => true) as unknown as MainRpcFn
    const spec = calendarSpecs(mainRpc).find((s) => s.name === 'delete_local')!
    const out = (await spec.build({} as never).execute('id', { id: 'abc' })) as {
      content: { text: string }[]
    }
    expect(mainRpc).toHaveBeenCalledWith('calendar.delete_local', ['abc'])
    expect(out.content[0].text).toContain('deleted')
  })

  it('surfaces main-rpc errors as tool errors', async () => {
    const mainRpc = vi.fn(async () => {
      throw new Error('boom')
    }) as unknown as MainRpcFn
    const spec = calendarSpecs(mainRpc).find((s) => s.name === 'list_upcoming')!
    const out = (await spec.build({} as never).execute('id', {})) as { details: { error: string } }
    expect(out.details.error).toContain('boom')
  })
})
