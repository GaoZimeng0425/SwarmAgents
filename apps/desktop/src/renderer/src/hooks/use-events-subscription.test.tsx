// @vitest-environment jsdom

import type { UIEvent } from '@swarm/protocol'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '../lib/api'
import { useSessionsStore } from '../stores/sessions'
import { useEventsSubscription } from './use-events-subscription'

vi.mock('sonner', () => ({ toast: vi.fn() }))

const navigateSpy = vi.fn()
vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigateSpy,
}))

// useEventsSubscription now sources openSettings from useSettingsNav
// (router-derived). Mock the hook so the component mounts without a router
// context; the settings-navigation test asserts the spy is invoked with the
// section mapped from the deep-link route.
const openSettingsSpy = vi.fn()
vi.mock('./use-settings-nav', () => ({
  useSettingsNav: () => ({
    open: false,
    section: null,
    openSettings: openSettingsSpy,
    close: vi.fn(),
  }),
}))

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

let settingsNavCb: ((route: string) => void) | null = null

function mount(): (e: UIEvent) => void {
  let emit: (e: UIEvent) => void = () => {}
  vi.spyOn(api.swarmApi, 'subscribeEvents').mockImplementation((cb) => {
    emit = cb
    return () => {}
  })
  vi.spyOn(api.swarmApi, 'consumePendingDeepLink').mockResolvedValue(null)
  vi.spyOn(api.swarmApi, 'onNavigateToSession').mockReturnValue(() => {})
  vi.spyOn(api.swarmApi, 'onNavigateToSettings').mockImplementation((cb) => {
    settingsNavCb = cb
    return () => {}
  })
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } } })
  renderHook(() => useEventsSubscription(), { wrapper: makeWrapper(qc) })
  return (e) => emit(e)
}

beforeEach(() => {
  vi.clearAllMocks()
  useSessionsStore.setState({
    sessions: [
      {
        id: 'bg',
        title: 'Background',
        status: 'active',
        lastActiveAt: 1,
        taskCount: 0,
        pinned: false,
        sortOrder: 0,
        isSystem: false,
      },
    ],
    selectedSessionId: 'current',
    unread: {},
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useEventsSubscription — background session activity', () => {
  it('toasts and marks unread for a milestone event in a non-active session', async () => {
    const emit = mount()
    act(() => {
      emit({ kind: 'agent_start', sessionId: 'bg', runId: 'r1' })
    })
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1))
    expect(toast).toHaveBeenCalledWith('「Background」开始了新任务', expect.objectContaining({ id: 'activity-bg' }))
    expect(useSessionsStore.getState().unread).toEqual({ bg: true })
  })

  it('does nothing for the currently active session', async () => {
    const emit = mount()
    act(() => {
      emit({ kind: 'agent_start', sessionId: 'current', runId: 'r1' })
    })
    await waitFor(() => expect(api.swarmApi.subscribeEvents).toHaveBeenCalled())
    expect(toast).not.toHaveBeenCalled()
    expect(useSessionsStore.getState().unread).toEqual({})
  })

  it('marks unread but does not toast for non-milestone events', async () => {
    const emit = mount()
    act(() => {
      emit({ kind: 'turn_start', sessionId: 'bg', runId: 'r1' })
    })
    await waitFor(() => expect(useSessionsStore.getState().unread).toEqual({ bg: true }))
    expect(toast).not.toHaveBeenCalled()
  })

  it('ignores events for a session not in the store (hidden child/delegate) — no toast, no unread', async () => {
    const emit = mount()
    act(() => {
      emit({ kind: 'agent_start', sessionId: 'child-xyz', runId: 'r1' })
    })
    await waitFor(() => expect(api.swarmApi.subscribeEvents).toHaveBeenCalled())
    expect(toast).not.toHaveBeenCalled()
    expect(useSessionsStore.getState().unread).toEqual({})
  })
})

describe('useEventsSubscription — choice card OS notification', () => {
  let NotificationMock: ReturnType<typeof vi.fn> & { permission?: string; requestPermission?: () => void }

  beforeEach(() => {
    NotificationMock = Object.assign(vi.fn(), { permission: 'granted', requestPermission: vi.fn() })
    vi.stubGlobal('Notification', NotificationMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const choiceStart = (sessionId: string) =>
    ({
      kind: 'tool_execution_start',
      sessionId,
      runId: 'r1',
      toolCallId: 'tc1',
      toolName: 'render_ui',
      args: { type: 'choice', props: { question: '继续吗?' } },
    }) as unknown as UIEvent

  it('fires an OS notification for a render_ui choice card in a known background session', async () => {
    const emit = mount()
    act(() => {
      emit(choiceStart('bg'))
    })
    await waitFor(() => expect(NotificationMock).toHaveBeenCalled())
    expect(NotificationMock).toHaveBeenCalledWith('Background', expect.objectContaining({ body: '继续吗?' }))
  })

  it('does not fire for a choice card in an unknown (child) session', async () => {
    const emit = mount()
    act(() => {
      emit(choiceStart('child-xyz'))
    })
    await waitFor(() => expect(api.swarmApi.subscribeEvents).toHaveBeenCalled())
    expect(NotificationMock).not.toHaveBeenCalled()
  })
})

describe('useEventsSubscription — settings navigation', () => {
  it('opens the settings dialog at the mapped section when main pushes swarm:navigate-settings', () => {
    mount()
    expect(settingsNavCb).toBeTypeOf('function')
    settingsNavCb?.('/settings/providers')
    // openSettings (router-derived via useSettingsNav) is called with the
    // section mapped from the deep-link route; the legacy /settings route is
    // NOT passed to navigate.
    expect(openSettingsSpy).toHaveBeenCalledWith('providers')
    expect(navigateSpy).not.toHaveBeenCalledWith({ to: '/settings/providers' })
  })
})
