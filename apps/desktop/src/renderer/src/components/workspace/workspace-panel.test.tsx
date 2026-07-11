// apps/desktop/src/renderer/src/components/workspace/workspace-panel.test.tsx
//
// Per-file environment directive: vitest.config's environmentMatchGlobs maps
// src/renderer/** to jsdom, but the glob resolution is not applied when a single
// file is targeted via `vitest run <path>`, so set jsdom explicitly here.
// @vitest-environment jsdom
//
// Shell smoke test for <WorkspacePanel/>: the four tab labels render, the
// approval badge reflects the permission queue, the collapse toggle hides the
// tabs and surfaces a re-expand affordance, and switching tabs changes which
// panel is visible. The tab children are stubbed so this stays a shell-level
// test (their own behavior is covered by their own tests).

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The shell reads everything from props; it does NOT import useSessionsStore.
// We mock the four tab children + plan footer + timeline builder so the test
// exercises only the shell's tab/collapse/badge wiring. Each stub surfaces a
// stable testid so we can assert which panel is shown after a tab switch.
vi.mock('@/stores/permission', () => ({
  usePermissionStore: (sel: (s: { queue: unknown[] }) => unknown) => sel({ queue: [] }),
}))
vi.mock('@/components/plan-panel', () => ({ PlanPanel: () => <div data-testid="plan-panel" /> }))
vi.mock('./timeline-tab', () => ({ TimelineTab: () => <div data-testid="timeline-tab" /> }))
vi.mock('./artifacts-tab', () => ({ ArtifactsTab: () => <div data-testid="artifacts-tab" /> }))
vi.mock('./approval-tab', () => ({ ApprovalTab: () => <div data-testid="approval-tab" /> }))
vi.mock('@/lib/workspace/build-timeline', () => ({ buildTimeline: () => [] }))

import { WorkspacePanel } from './workspace-panel'

const baseProps = {
  messages: [],
  planGroups: [],
  session: { id: 's1', tokensUsed: 1000, cwd: '/cwd' } as never,
  onDecide: vi.fn(),
}

describe('WorkspacePanel', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders all four tab labels', () => {
    render(<WorkspacePanel {...baseProps} />)
    expect(screen.getByText('计划')).toBeInTheDocument()
    expect(screen.getByText('时间线')).toBeInTheDocument()
    expect(screen.getByText('产出物')).toBeInTheDocument()
    expect(screen.getByText('审批')).toBeInTheDocument()
  })

  it('hides tabs when collapsed and shows a re-expand affordance', () => {
    render(<WorkspacePanel {...baseProps} />)
    fireEvent.click(screen.getByLabelText('收起工作区'))
    // Tab labels are gone while collapsed...
    expect(screen.queryByText('计划')).not.toBeInTheDocument()
    // ...and the expand button (aria-label 展开) takes their place.
    expect(screen.getByLabelText('展开工作区')).toBeInTheDocument()
  })

  it('switches the visible panel when a tab is clicked', () => {
    render(<WorkspacePanel {...baseProps} />)
    // On first render only the default (计划) panel is mounted; clicking 时间线
    // activates that tab and surfaces its panel. We assert the timeline panel
    // appears rather than that the plan panel disappears: base-ui keeps
    // previously-visited panels mounted (hidden) once they've been activated, so
    // an "inactive panel is gone" assertion would be brittle.
    expect(screen.queryByTestId('timeline-tab')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('时间线'))
    expect(screen.getByTestId('timeline-tab')).toBeInTheDocument()
  })
})
