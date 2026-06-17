// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PermissionPrompt } from '@/stores/permission'
import { PermissionDrawer } from './permission-drawer'

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

describe('PermissionDrawer', () => {
  it('renders nothing when prompt is null', () => {
    const { container } = render(<PermissionDrawer onDecide={() => {}} prompt={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders as a region (not a dialog) and exposes risk via data-risk', () => {
    render(<PermissionDrawer onDecide={() => {}} prompt={{ ...basePrompt, risk: 'high' }} />)
    const region = screen.getByRole('region', { name: /requires confirmation/i })
    expect(region).toHaveAttribute('data-risk', 'high')
  })

  it('Escape resolves the prompt as skip', () => {
    const onDecide = vi.fn()
    render(<PermissionDrawer onDecide={onDecide} prompt={basePrompt} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDecide).toHaveBeenCalledWith('act-1', 'skip')
  })

  it('high-risk autofocuses the Deny button', () => {
    render(<PermissionDrawer onDecide={() => {}} prompt={{ ...basePrompt, risk: 'high' }} />)
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus()
  })
})
