// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import type { PlanTodo } from '@shared/types/task'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PermissionPrompt } from '@/stores/permission'
import { ComposerOverlay } from './composer-overlay'

const prompt = (actionId: string): PermissionPrompt => ({
  actionId,
  sessionId: 'sess-1',
  taskId: 'task-1',
  workerId: null,
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
    fireEvent.keyDown(window, { key: 'Escape' })
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
})
