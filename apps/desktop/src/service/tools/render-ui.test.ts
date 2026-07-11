import type { MessageWireEvent } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import type { ToolRunContext } from './registry'
import { readAnalysisCard, renderUiSpec } from './render-ui'

const ctx = {
  sessionId: 's1',
  taskId: 't1',
  spawnChild: async () => ({ messageId: 'c', status: 'completed', summary: '', artifacts: [] }),
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

  it('terminates the turn for a non-interactive analysis card', async () => {
    const tool = renderUiSpec().build(ctx)
    const res = (await tool.execute('id', { type: 'analysis', props: { todos: [] } })) as { terminate?: boolean }
    expect(res.terminate).toBe(true)
  })
})

const analysisEvent = (props: unknown): MessageWireEvent =>
  ({
    kind: 'message.progress',
    event: { kind: 'tool.call', server: 'agent', tool: 'render_ui', args: { type: 'analysis', props } },
  }) as unknown as MessageWireEvent

describe('readAnalysisCard', () => {
  it('extracts props from a render_ui analysis tool call', () => {
    expect(readAnalysisCard(analysisEvent({ todos: [], suggest: 'x' }))).toEqual({ todos: [], suggest: 'x' })
  })

  it('coerces props delivered as a JSON string', () => {
    expect(readAnalysisCard(analysisEvent(JSON.stringify({ gist: 'g' })))).toEqual({ gist: 'g' })
  })

  it('returns null for a non-analysis render_ui card', () => {
    const e = {
      kind: 'message.progress',
      event: { kind: 'tool.call', server: 'agent', tool: 'render_ui', args: { type: 'choice' } },
    } as unknown as MessageWireEvent
    expect(readAnalysisCard(e)).toBeNull()
  })

  it('returns null for a non-tool-call event', () => {
    const e = {
      kind: 'message.progress',
      event: { kind: 'llm.message', role: 'assistant', content: 'hi' },
    } as unknown as MessageWireEvent
    expect(readAnalysisCard(e)).toBeNull()
  })
})
