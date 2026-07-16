import type { AgentWireEvent } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { parseChoiceCard } from './choice-notification'

type ToolExecutionStart = Extract<AgentWireEvent, { kind: 'tool_execution_start' }>

const toolStart = (toolName: string, args: unknown): ToolExecutionStart => ({
  kind: 'tool_execution_start',
  sessionId: 'ses-1',
  runId: 'r1',
  toolCallId: 'tc-1',
  toolName,
  args,
})

describe('parseChoiceCard', () => {
  it('returns the question for a single-select choice card', () => {
    const e = toolStart('render_ui', { type: 'choice', props: { question: '部署到哪个环境?', mode: 'single' } })
    expect(parseChoiceCard(e)).toEqual({ question: '部署到哪个环境?' })
  })

  it('returns the question for a multi-select choice card', () => {
    const e = toolStart('render_ui', { type: 'choice', props: { question: '选择功能', mode: 'multi' } })
    expect(parseChoiceCard(e)).toEqual({ question: '选择功能' })
  })

  it('parses props delivered as a JSON string', () => {
    const e = toolStart('render_ui', { type: 'choice', props: '{"question":"继续吗?","mode":"single"}' })
    expect(parseChoiceCard(e)).toEqual({ question: '继续吗?' })
  })

  it('falls back to a default question when none is given', () => {
    const e = toolStart('render_ui', { type: 'choice', props: { mode: 'single' } })
    expect(parseChoiceCard(e)).toEqual({ question: '需要你的选择' })
  })

  it('returns null for a non-choice render_ui card (e.g. weather)', () => {
    const e = toolStart('render_ui', { type: 'weather', props: { city: 'Tokyo' } })
    expect(parseChoiceCard(e)).toBeNull()
  })

  it('returns null for a different tool', () => {
    const e = toolStart('run_shell', { command: 'ls' })
    expect(parseChoiceCard(e)).toBeNull()
  })
})
