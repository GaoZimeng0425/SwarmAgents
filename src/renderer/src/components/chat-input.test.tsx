// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatInput } from './chat-input'

// No configured providers → the model/thinking pickers stay hidden, keeping the
// render focused on the three composer controls under test.
vi.mock('@/hooks/use-providers', () => ({
  useProviders: () => ({ state: { active: null, providers: [] }, ready: false, decryptFailed: false }),
}))

// The attachment viewer pulls in a heavy xlsx-preview dependency (us-atlas) that
// the test loader can't import; it is irrelevant to the controls under test.
vi.mock('@/components/attachment-viewer-sheet', () => ({
  AttachmentViewerSheet: () => null,
}))

const pickDirectory = vi.fn<() => Promise<string | null>>()
const pickFile = vi.fn<() => Promise<string | null>>()

beforeEach(() => {
  pickDirectory.mockReset()
  pickFile.mockReset()
  ;(globalThis as unknown as { window: Window }).window.swarm = {
    pickDirectory,
    pickFile,
  } as unknown as Window['swarm']
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// The execution-mode toggle (goal/plan) was folded into the "＋" add-menu in the
// footer, so its label is only mounted once that menu is open. Open it via the
// menu trigger (the icon-only button carrying aria-haspopup="menu").
function openAddMenu() {
  const trigger = document.querySelector('[aria-haspopup="menu"]')
  if (!trigger) throw new Error('add-menu trigger not found')
  fireEvent.click(trigger)
}

describe('ChatInput composer controls', () => {
  it('renders the working-directory chip plus the permission select, and the execution mode in the add-menu', async () => {
    render(<ChatInput executionMode="goal" onSubmit={vi.fn()} permissionMode="ask" />)
    expect(screen.getByText('工作目录')).toBeInTheDocument()
    expect(screen.getByText('询问权限')).toBeInTheDocument()
    openAddMenu()
    await waitFor(() => expect(screen.getByText('目标模式')).toBeInTheDocument())
  })

  it('reflects the current cwd basename and a non-default mode in the controls', async () => {
    render(<ChatInput cwd="/Users/me/project" executionMode="plan" onSubmit={vi.fn()} permissionMode="full" />)
    expect(screen.getByText('project')).toBeInTheDocument()
    expect(screen.getByText('完全操作权限')).toBeInTheDocument()
    openAddMenu()
    await waitFor(() => expect(screen.getByText('计划模式')).toBeInTheDocument())
  })

  it('opens the native folder dialog and reports the chosen path via onCwdChange', async () => {
    pickDirectory.mockResolvedValue('/picked/dir')
    const onCwdChange = vi.fn()
    render(<ChatInput executionMode="goal" onCwdChange={onCwdChange} onSubmit={vi.fn()} permissionMode="ask" />)

    fireEvent.click(screen.getByText('工作目录'))

    await waitFor(() => expect(pickDirectory).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onCwdChange).toHaveBeenCalledWith('/picked/dir'))
  })

  it('does not call onCwdChange when the folder dialog is cancelled', async () => {
    pickDirectory.mockResolvedValue(null)
    const onCwdChange = vi.fn()
    render(<ChatInput executionMode="goal" onCwdChange={onCwdChange} onSubmit={vi.fn()} permissionMode="ask" />)

    fireEvent.click(screen.getByText('工作目录'))

    await waitFor(() => expect(pickDirectory).toHaveBeenCalledTimes(1))
    expect(onCwdChange).not.toHaveBeenCalled()
  })
})
