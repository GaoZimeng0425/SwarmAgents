// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatInput } from './chat-input'

// Helper so tests don't repeat the minimum required props.
function renderChatInput(props: Partial<React.ComponentProps<typeof ChatInput>> = {}) {
  return render(<ChatInput executionMode="direct" onSubmit={vi.fn()} permissionMode="ask" {...props} />)
}

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

// The execution-mode toggle (direct/plan) was folded into the "＋" add-menu in the
// footer, so its label is only mounted once that menu is open. Open it via the
// menu trigger (the icon-only button carrying aria-haspopup="menu").
function openAddMenu() {
  const trigger = document.querySelector('[aria-haspopup="menu"]')
  if (!trigger) throw new Error('add-menu trigger not found')
  fireEvent.click(trigger)
}

describe('ChatInput composer controls', () => {
  it('renders the working-directory chip plus the permission select, and the execution mode in the add-menu', async () => {
    render(<ChatInput executionMode="direct" onSubmit={vi.fn()} permissionMode="ask" />)
    expect(screen.getByText('工作目录')).toBeInTheDocument()
    expect(screen.getByText('询问权限')).toBeInTheDocument()
    openAddMenu()
    await waitFor(() => expect(screen.getByText('直接执行')).toBeInTheDocument())
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
    render(<ChatInput executionMode="direct" onCwdChange={onCwdChange} onSubmit={vi.fn()} permissionMode="ask" />)

    // The working-directory control is now a menu; "选择目录…" is the only entry
    // that opens the native dialog.
    fireEvent.click(screen.getByText('工作目录'))
    fireEvent.click(await screen.findByText('选择目录…'))

    await waitFor(() => expect(pickDirectory).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onCwdChange).toHaveBeenCalledWith('/picked/dir'))
  })

  it('does not call onCwdChange when the folder dialog is cancelled', async () => {
    pickDirectory.mockResolvedValue(null)
    const onCwdChange = vi.fn()
    render(<ChatInput executionMode="direct" onCwdChange={onCwdChange} onSubmit={vi.fn()} permissionMode="ask" />)

    fireEvent.click(screen.getByText('工作目录'))
    fireEvent.click(await screen.findByText('选择目录…'))

    await waitFor(() => expect(pickDirectory).toHaveBeenCalledTimes(1))
    expect(onCwdChange).not.toHaveBeenCalled()
  })

  it('always exposes a submit affordance and never a stop one', async () => {
    const onSubmit = vi.fn()
    renderChatInput({ onSubmit }) // composer is status-agnostic after this task
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.submit(textarea.closest('form')!)
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('hello', undefined))
    // The composer exposes a Submit affordance, never a Stop one.
    expect(screen.queryByLabelText('Stop')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Submit')).toBeInTheDocument()
  })

  it('flips the submit button to a stop control while running and fires onStop', () => {
    const onStop = vi.fn()
    renderChatInput({ running: true, onStop })
    // While a turn is in flight the same button becomes Stop, not Submit.
    expect(screen.queryByLabelText('Submit')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Stop'))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  // The team selector's trigger reflects the chosen team head's label; it is
  // absent entirely when no team options are supplied (e.g. roster not loaded).
  it('renders the team selector reflecting the chosen team head, and hides it without options', () => {
    const teams = [
      { id: 'ceo', label: '公司 (CEO)' },
      { id: 'pm', label: '开发团队' },
      { id: 'training-head', label: 'Agent 训练团队' },
    ]
    const { rerender } = render(
      <ChatInput
        agentType="ceo"
        executionMode="direct"
        onAgentTypeChange={vi.fn()}
        onSubmit={vi.fn()}
        permissionMode="ask"
        teamOptions={teams}
      />
    )
    expect(screen.getAllByText('公司 (CEO)').length).toBeGreaterThan(0)

    rerender(
      <ChatInput
        agentType="training-head"
        executionMode="direct"
        onAgentTypeChange={vi.fn()}
        onSubmit={vi.fn()}
        permissionMode="ask"
        teamOptions={teams}
      />
    )
    expect(screen.getAllByText('Agent 训练团队').length).toBeGreaterThan(0)

    rerender(<ChatInput executionMode="direct" onSubmit={vi.fn()} permissionMode="ask" />)
    expect(screen.queryByText('Agent 训练团队')).not.toBeInTheDocument()
  })
})
