import { describe, expect, it } from 'vitest'

import type { ToolRunContext } from './registry'
import { renderUiSpec } from './render-ui'

const ctx = {
  sessionId: 's1',
  taskId: 't1',
  spawnChild: async () => ({ runId: 'c', status: 'completed', summary: '', artifacts: [] }),
  send: () => undefined,
  requestPermission: async () => 'grant' as const,
} as unknown as ToolRunContext

describe('render_ui', () => {
  it('returns the spec as details without blocking', async () => {
    const tool = renderUiSpec().build(ctx)
    const res = (await tool.execute('id', { type: 'weather', props: { city: 'SF', tempC: 18 } })) as {
      details: { type?: string; props?: unknown; error?: string }
    }
    expect(res.details.error).toBeUndefined()
    expect(res.details.type).toBe('weather')
    expect(res.details.props).toEqual({ city: 'SF', tempC: 18 })
  })

  it('errors when type is missing or blank', async () => {
    const tool = renderUiSpec().build(ctx)
    const res = (await tool.execute('id', { props: {} })) as { details: { error?: string } }
    expect(res.details.error).toBeDefined()
  })

  it('terminates the turn for an interactive choice card', async () => {
    const tool = renderUiSpec().build(ctx)
    const res = (await tool.execute('id', { type: 'choice', props: { options: ['a', 'b'] } })) as {
      terminate?: boolean
    }
    expect(res.terminate).toBe(true)
  })

  it('does not terminate the turn for a non-interactive card', async () => {
    const tool = renderUiSpec().build(ctx)
    const res = (await tool.execute('id', { type: 'weather', props: { city: 'SF' } })) as {
      terminate?: boolean
    }
    expect(res.terminate).toBeUndefined()
  })
})
