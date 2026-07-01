// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PermissionPrompt } from '@/stores/permission'
import { PermissionCard } from './permission-card'

const basePrompt: PermissionPrompt = {
  actionId: 'act-1',
  sessionId: 'sess-1',
  taskId: 'task-1',
  workerId: null,
  risk: 'medium',
  summary: 'Run shell command',
  payload: { cmd: 'ls' },
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PermissionCard', () => {
  it('renders as a region (not a dialog) and exposes risk via data-risk', () => {
    render(<PermissionCard onDecide={() => {}} prompt={{ ...basePrompt, risk: 'high' }} />)
    const region = screen.getByRole('region', { name: /requires confirmation/i })
    expect(region).toHaveAttribute('data-risk', 'high')
  })

  it('fires the matching decision for each action button', () => {
    const onDecide = vi.fn()
    render(<PermissionCard onDecide={onDecide} prompt={basePrompt} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onDecide).toHaveBeenCalledWith('act-1', 'deny')
  })

  it('autofocuses Deny for high-risk only when it is the top of the stack', () => {
    render(<PermissionCard autoFocusDeny onDecide={() => {}} prompt={{ ...basePrompt, risk: 'high' }} />)
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus()
  })

  it('does not autofocus Deny when not the top of the stack', () => {
    render(<PermissionCard onDecide={() => {}} prompt={{ ...basePrompt, risk: 'high' }} />)
    expect(screen.getByRole('button', { name: 'Deny' })).not.toHaveFocus()
  })
})
