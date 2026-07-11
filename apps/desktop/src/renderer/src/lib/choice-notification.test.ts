import type { UIEvent } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { parseChoiceCard } from './choice-notification'

const progress = (event: unknown): UIEvent =>
  ({ kind: 'message.progress', sessionId: 'ses-1', messageId: 't1', event, ts: 1 }) as UIEvent

const toolCall = (tool: string, args: unknown): unknown => ({ kind: 'tool.call', server: 'agent', tool, args, ts: 1 })

describe('parseChoiceCard', () => {
  it('returns the question for a single-select choice card', () => {
    const e = progress(
      toolCall('render_ui', { type: 'choice', props: { question: '部署到哪个环境?', mode: 'single' } })
    )
    expect(parseChoiceCard(e)).toEqual({ question: '部署到哪个环境?' })
  })

  it('returns the question for a multi-select choice card', () => {
    const e = progress(toolCall('render_ui', { type: 'choice', props: { question: '选择功能', mode: 'multi' } }))
    expect(parseChoiceCard(e)).toEqual({ question: '选择功能' })
  })

  it('parses props delivered as a JSON string', () => {
    const e = progress(toolCall('render_ui', { type: 'choice', props: '{"question":"继续吗?","mode":"single"}' }))
    expect(parseChoiceCard(e)).toEqual({ question: '继续吗?' })
  })

  it('falls back to a default question when none is given', () => {
    const e = progress(toolCall('render_ui', { type: 'choice', props: { mode: 'single' } }))
    expect(parseChoiceCard(e)).toEqual({ question: '需要你的选择' })
  })

  it('returns null for a non-choice render_ui card (e.g. weather)', () => {
    const e = progress(toolCall('render_ui', { type: 'weather', props: { city: 'Tokyo' } }))
    expect(parseChoiceCard(e)).toBeNull()
  })

  it('returns null for a different tool', () => {
    const e = progress(toolCall('run_shell', { command: 'ls' }))
    expect(parseChoiceCard(e)).toBeNull()
  })

  it('returns null for a non-tool-call progress event', () => {
    const e = progress({ kind: 'reasoning', content: 'thinking', ts: 1 })
    expect(parseChoiceCard(e)).toBeNull()
  })

  it('returns null for a non-progress event', () => {
    expect(
      parseChoiceCard({ kind: 'message.complete', sessionId: 'ses-1', messageId: 't1', summary: 'x', ts: 1 } as UIEvent)
    ).toBeNull()
  })
})
