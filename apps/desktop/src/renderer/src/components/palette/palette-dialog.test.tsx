// apps/desktop/src/renderer/src/components/palette/palette-dialog.test.tsx
// @vitest-environment jsdom
//
// Integration smoke test for the ⌘K palette. Renders the full
// <SessionSearchDialog/> (which mounts <PaletteDialog/>) with all data hooks,
// side-effect hooks, swarmApi, theme, router and hotkeys mocked, then
// exercises: scope filtering (the `>` prefix), keyboard nav (ArrowDown +
// Enter), run() invocation (the mocked openSettings), the lone-prefix
// Backspace reset, the footer status bar, and the empty-state.
//
// The module mocks mirror hooks/use-palette-data.test.tsx for the data layer
// and additionally stub the side-effect entry points used by palette-dialog.
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Data hooks (same shape as use-palette-data.test.tsx) -------------------
vi.mock('../../stores/sessions', () => ({
  useSessionsStore: (sel: (s: any) => any) =>
    sel({
      sessions: [
        {
          id: 'sys',
          title: '系统',
          isSystem: true,
          lastActiveAt: 0,
          sortOrder: 0,
          pinned: false,
          status: 'active',
          taskCount: 0,
        },
        {
          id: 's1',
          title: 'Chat',
          isSystem: false,
          lastActiveAt: 1,
          sortOrder: 1,
          pinned: false,
          status: 'active',
          taskCount: 0,
          agentType: 'ceo',
        },
      ],
      selectedSessionId: 's1',
    }),
}))

vi.mock('../../hooks/use-runs', () => ({
  // useSubmitGoal is consumed by palette-dialog; stub it as a no-op mutation so
  // the hero dispatch item's run() doesn't blow up if it ever fires.
  useSubmitGoal: () => ({
    mutateAsync: vi.fn().mockResolvedValue({ sessionId: 'new-session' }),
  }),
  useRuns: () => [{ id: 'r1', sessionId: 's1', goal: 'g', status: 'running', summary: null, events: [] }],
}))

vi.mock('../../hooks/use-cron', () => ({
  useAllCronJobs: () => ({
    data: [
      {
        id: 'c1',
        sessionId: 'sys',
        name: '日报',
        cron: '0 9 * * *',
        nextRun: 1,
        lastRunAt: 0,
        lastStatus: null,
        originSessionId: null,
        sessionTitle: null,
        originSessionTitle: null,
        createdAt: 0,
        goal: '',
      },
    ],
  }),
}))

vi.mock('../../hooks/use-agents', () => ({
  useTeamOptions: () => [{ id: 'ceo', label: '公司 (CEO)' }],
}))

vi.mock('../../hooks/use-memory', () => ({
  useMemory: () => ({ entries: [], isError: false, refetch: () => {} }),
}))

vi.mock('../../hooks/use-skills', () => ({
  useSkills: () => ({ skills: [], setSkills: () => {}, reload: () => {} }),
}))

// swarmApi: listArtifacts drives a useQuery in usePaletteData; getRunEvents
// drives the lazy preview queries for chat/task-run. Both resolve [] so the
// preview pane never throws.
vi.mock('../../lib/api', () => ({
  swarmApi: {
    listArtifacts: vi.fn().mockResolvedValue([]),
    exportSessionMarkdown: vi.fn().mockResolvedValue({ path: '/tmp/x.md' }),
    getRunEvents: vi.fn().mockResolvedValue([]),
    submitGoal: vi.fn().mockResolvedValue({ sessionId: 'new-session' }),
  },
}))

// --- Side-effect / context mocks -------------------------------------------
// Force the palette open: SessionSearchDialog reads `open` from this store.
const closeMock = vi.fn()
const toggleMock = vi.fn()
vi.mock('../../stores/search-dialog', () => ({
  useSearchDialog: (sel: (s: any) => any) =>
    sel({ open: true, close: closeMock, toggle: toggleMock, openSearch: vi.fn() }),
}))

// openSettings is wired into the 「打开设置」 command's run(). The dialog now
// sources it from useSettingsNav (router-derived); mock the hook directly so
// the component mounts without a router context.
const openSettingsMock = vi.fn()
vi.mock('../../hooks/use-settings-nav', () => ({
  useSettingsNav: () => ({
    open: false,
    section: null,
    openSettings: openSettingsMock,
    close: vi.fn(),
  }),
}))

vi.mock('../../stores/composer-defaults', () => ({
  useComposerDefaults: (sel: (s: any) => any) => sel({ setAgentType: vi.fn() }),
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}))

const navigateMock = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}))

// react-hotkeys registers the global ⌘K listener in SessionSearchDialog; the
// jsdom env can't service it, so a no-op keeps the mount clean.
vi.mock('@tanstack/react-hotkeys', () => ({
  useHotkey: () => {},
}))

import { SessionSearchDialog } from '../session-search-dialog'

function renderPalette() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SessionSearchDialog />
    </QueryClientProvider>
  )
}

// The palette input is the single <input> in the dialog (the dispatch preview's
// <select> is a different element). Grabbing it by placeholder is robust to the
// scope changing: when scope=mixed the placeholder is the long 搜索… string; in
// command scope it's 运行命令…. We just match any input of type text.
function queryInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')
  if (!el) throw new Error('palette input not found')
  return el
}

describe('SessionSearchDialog — palette integration smoke test', () => {
  beforeEach(() => {
    closeMock.mockReset()
    toggleMock.mockReset()
    openSettingsMock.mockReset()
    navigateMock.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('mounts with the input focusable and the footer status bar visible', () => {
    renderPalette()
    const input = queryInput()
    expect(input).toBeInTheDocument()
    // The input auto-focuses on mount (palette-input.tsx mount effect).
    expect(document.activeElement).toBe(input)
    // Footer is rendered: the mixed home row's hero is selected by default
    // (selIndex 0), so the left label shows its title — not 未选择. The two
    // kbd legends (执行 / 操作) are always present.
    expect(screen.getByText('执行')).toBeInTheDocument()
    expect(screen.getByText('操作')).toBeInTheDocument()
    expect(screen.queryByText('未选择')).not.toBeInTheDocument()
  })

  it('typing ">" then "set" filters commands so 「打开设置」 is the only command row', () => {
    renderPalette()
    const input = queryInput()
    fireEvent.change(input, { target: { value: '>' } })
    // In command scope, 「打开设置」 is one of the built-in commands.
    // The title also appears in the right-pane info preview, so scope the
    // query to the left results column (the only scrollable region rendered
    // by PaletteResults). At minimum one instance must be present.
    expect(screen.getAllByText('打开设置').length).toBeGreaterThan(0)
    // And the chat row (mixed home) is gone — scope switched to command.
    expect(screen.queryByText('Chat')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: '>set' } })
    // 打开设置 still matches; 切换外观 (theme) does not contain "set".
    expect(screen.getAllByText('打开设置').length).toBeGreaterThan(0)
    expect(screen.queryByText('切换外观')).not.toBeInTheDocument()
  })

  it('ArrowDown + Enter on 「打开设置」 invokes the mocked openSettings', () => {
    renderPalette()
    const input = queryInput()
    fireEvent.change(input, { target: { value: '>set' } })

    // The only command row left is 「打开设置」, so it's already at selIndex 0;
    // Enter must fire its run() → openSettings().
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(openSettingsMock).toHaveBeenCalledTimes(1)
    // navigate is wired into other commands but not this one.
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('Backspace on the lone ">" prefix clears the input and returns to mixed scope', () => {
    renderPalette()
    const input = queryInput()
    fireEvent.change(input, { target: { value: '>' } })
    expect(screen.queryByText('Chat')).not.toBeInTheDocument()

    // Backspace with the input holding exactly ">" → controller clears the
    // query, scope snaps back to mixed, and the recent-chat row reappears.
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(input.value).toBe('')
    expect(screen.getByText('Chat')).toBeInTheDocument()
  })

  it('renders the empty-state message for a command-scope no-match query', () => {
    renderPalette()
    const input = queryInput()
    // No command's searchText contains "zzzqqq".
    fireEvent.change(input, { target: { value: '>zzzqqq' } })
    expect(screen.getByText(/没有匹配/)).toBeInTheDocument()
    // With an empty flat list, the footer shows the no-selection label.
    expect(screen.getByText('未选择')).toBeInTheDocument()
  })

  it('clicking the 「打开设置」 row invokes its run()', async () => {
    renderPalette()
    fireEvent.change(queryInput(), { target: { value: '>' } })
    // The row is a <button> wrapping the title text.
    const row = screen.getByText('打开设置').closest('button')
    expect(row).not.toBeNull()
    fireEvent.click(row!)
    await waitFor(() => expect(openSettingsMock).toHaveBeenCalledTimes(1))
  })
})
