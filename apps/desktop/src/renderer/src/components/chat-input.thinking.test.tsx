// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import type { ProvidersStateView, ProviderView } from '@swarm/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatInput } from './chat-input'

// A provider with several thinking levels so the TanStack Ranger stepper renders
// inside the model picker. Cast to ProviderView — only the fields the composer
// reads matter at runtime.
const provider = {
  id: 'p1',
  name: 'Test',
  apiStyle: 'openai',
  hasKey: true,
  supportsImages: false,
  models: ['model-a'],
  model: 'model-a',
  thinkingLevels: ['off', 'low', 'medium', 'high'],
  thinkingLevel: 'low',
} as unknown as ProviderView

const state: ProvidersStateView = { active: 'p1', providers: [provider] }

vi.mock('@/hooks/use-providers', () => ({
  useProviders: () => ({ state, ready: true, decryptFailed: false }),
}))

vi.mock('@/components/attachment-viewer-sheet', () => ({
  AttachmentViewerSheet: () => null,
}))

const setThinkingLevel = vi.fn<() => Promise<void>>()

beforeEach(() => {
  setThinkingLevel.mockReset().mockResolvedValue(undefined)
  ;(globalThis as unknown as { window: Window }).window.swarm = {
    pickDirectory: vi.fn(),
    pickFile: vi.fn(),
    providers: { setThinkingLevel, setActive: vi.fn(), setModel: vi.fn() },
  } as unknown as Window['swarm']
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ChatInput thinking stepper (TanStack Ranger)', () => {
  async function openStepper() {
    // The model picker trigger carries the model label; clicking it reveals the
    // popover that hosts the discrete thinking-level slider.
    fireEvent.click(screen.getByText(/model-a/i))
    return await screen.findByRole('slider', { name: '思考程度' })
  }

  it('ArrowRight commits the next level up', async () => {
    render(<ChatInput executionMode="goal" onSubmit={vi.fn()} permissionMode="ask" />)
    const slider = await openStepper()
    // Active level is 'low' (index 1); ArrowRight → 'medium'.
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    await waitFor(() => expect(setThinkingLevel).toHaveBeenCalledWith('p1', 'medium'))
  })

  it('ArrowLeft commits the next level down', async () => {
    render(<ChatInput executionMode="goal" onSubmit={vi.fn()} permissionMode="ask" />)
    const slider = await openStepper()
    // Active level is 'low' (index 1); ArrowLeft → 'off'.
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    await waitFor(() => expect(setThinkingLevel).toHaveBeenCalledWith('p1', 'off'))
  })

  it('does not commit past the top of the range', async () => {
    const top = { ...provider, thinkingLevel: 'high' } as unknown as ProviderView
    const topState: ProvidersStateView = { active: 'p1', providers: [top] }
    const mod = await import('@/hooks/use-providers')
    vi.spyOn(mod, 'useProviders').mockReturnValue({ state: topState, ready: true, decryptFailed: false } as never)

    render(<ChatInput executionMode="goal" onSubmit={vi.fn()} permissionMode="ask" />)
    const slider = await openStepper()
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    // Already at 'high' (last index): the clamp keeps it there, no commit.
    expect(setThinkingLevel).not.toHaveBeenCalled()
  })
})
