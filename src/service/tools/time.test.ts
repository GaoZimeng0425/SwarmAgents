import { describe, expect, it } from 'vitest'

import type { ToolRunContext } from './registry'
import { currentTimeSpec } from './time'

const ctx: ToolRunContext = {
  sessionId: 's',
  taskId: 't',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  send: () => undefined,
  requestPermission: async () => 'grant',
}
const tool = () => currentTimeSpec().build(ctx)

describe('current_time tool', () => {
  it('returns a UTC ISO timestamp and the resolved timezone', async () => {
    const res = await tool().execute('c', {})
    const details = res.details as { iso: string; epochMs: number; timezone: string }
    expect(details.iso).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    expect(typeof details.epochMs).toBe('number')
    expect(details.timezone).toBeTruthy()
    expect(res.content[0].text).toContain('UTC (ISO 8601):')
  })

  it('honors an explicit IANA timezone', async () => {
    const res = await tool().execute('c', { timezone: 'Asia/Tokyo' })
    expect((res.details as { timezone: string }).timezone).toBe('Asia/Tokyo')
  })

  it('surfaces an unknown timezone as an error result, not a throw', async () => {
    const res = await tool().execute('c', { timezone: 'Not/AZone' })
    expect((res.details as { error?: string }).error).toBeTruthy()
  })
})
