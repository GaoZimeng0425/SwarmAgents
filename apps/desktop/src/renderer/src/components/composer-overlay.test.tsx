// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { PlanTodo } from '@swarm/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PermissionPrompt } from '@/stores/permission'
import { ComposerOverlay } from './composer-overlay'

const prompt = (actionId: string): PermissionPrompt => ({
  actionId,
  sessionId: 'sess-1',
  runId: 'run-1',
  risk: 'medium',
  summary: 'Run shell command',
  payload: { cmd: 'ls' },
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ComposerOverlay', () => {
  it('renders nothing when there are no prompts and no running plan', () => {
    const { container } = render(<ComposerOverlay onDecide={() => {}} prompts={[]} running={false} todos={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('stacks every pending prompt', () => {
    render(<ComposerOverlay onDecide={() => {}} prompts={[prompt('a'), prompt('b')]} running={false} todos={[]} />)
    expect(screen.getAllByRole('region', { name: /requires confirmation/i })).toHaveLength(2)
  })

  it('Escape skips the top-most prompt', () => {
    const onDecide = vi.fn()
    render(<ComposerOverlay onDecide={onDecide} prompts={[prompt('a'), prompt('b')]} running={false} todos={[]} />)
    // react-hotkeys registers on `document`, where real Escape keystrokes bubble.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDecide).toHaveBeenCalledWith('a', 'skip')
  })

  it('shows the plan progress bar with step count while running', () => {
    const todos: PlanTodo[] = [
      { content: 'first step', status: 'in_progress' },
      { content: 'second step', status: 'pending' },
    ]
    render(<ComposerOverlay onDecide={() => {}} prompts={[]} running todos={todos} />)
    expect(screen.getByText('第 1/2 步')).toBeInTheDocument()
    expect(screen.getByText('first step')).toBeInTheDocument()
  })

  it('hides the plan progress bar when not running', () => {
    const todos: PlanTodo[] = [{ content: 'first step', status: 'in_progress' }]
    const { container } = render(<ComposerOverlay onDecide={() => {}} prompts={[]} running={false} todos={todos} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('hides the plan progress bar once every step is completed, even while running', () => {
    const todos: PlanTodo[] = [
      { content: 'first step', status: 'completed' },
      { content: 'second step', status: 'completed' },
    ]
    const { container } = render(<ComposerOverlay onDecide={() => {}} prompts={[]} running todos={todos} />)
    expect(container).toBeEmptyDOMElement()
  })

  const queued = [
    { id: 'q1', sessionId: 'sess-1', prompt: '修复登录 bug' },
    { id: 'q2', sessionId: 'sess-1', prompt: '加个导航' },
  ]

  it('renders one queued card per pending task with cancel + interrupt', () => {
    const onCancelQueued = vi.fn()
    const onInterrupt = vi.fn()
    render(
      <ComposerOverlay
        onCancelQueued={onCancelQueued}
        onDecide={() => {}}
        onInterrupt={onInterrupt}
        prompts={[]}
        queued={queued}
        running
        todos={[]}
      />
    )
    expect(screen.getByText('修复登录 bug')).toBeInTheDocument()
    expect(screen.getByText('加个导航')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /取消排队|cancel/i })[0])
    expect(onCancelQueued).toHaveBeenCalledWith('q1')
    fireEvent.click(screen.getAllByRole('button', { name: /打断|interrupt/i })[1])
    expect(onInterrupt).toHaveBeenCalledWith('q2')
  })

  it('renders pending permission cards inside a positioned cover layer', () => {
    const { container } = render(
      <ComposerOverlay onDecide={() => {}} prompts={[prompt('a')]} running={false} todos={[]} />
    )
    // The cover layer is the absolute-positioned wrapper that overlays the
    // composer box. Its presence + positioning is what makes the card COVER
    // the input rather than float above it.
    const cover = container.querySelector('.cover-zone')
    expect(cover).not.toBeNull()
    expect(cover).toHaveClass('absolute', 'inset-0')
    expect(cover).toHaveTextContent('Action requires confirmation')
  })

  it('keeps the plan progress bar in a floating zone, not the cover zone', () => {
    const todos: PlanTodo[] = [
      { content: 'first step', status: 'in_progress' },
      { content: 'second step', status: 'pending' },
    ]
    const { container } = render(<ComposerOverlay onDecide={() => {}} prompts={[]} running todos={todos} />)
    const cover = container.querySelector('.cover-zone')
    expect(cover).toBeNull()
    const floating = container.querySelector('.floating-zone')
    expect(floating).not.toBeNull()
    expect(floating).toHaveTextContent('第 1/2 步')
  })
})
