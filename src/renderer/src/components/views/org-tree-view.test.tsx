// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import type { AgentDefinition } from '@shared/types/agent'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OrgTree, OrgTreeView } from './org-tree-view'

vi.mock('@/hooks/use-agent-mutations', () => ({
  useAgentMutations: () => ({
    save: vi.fn(),
    remove: vi.fn(),
  }),
}))

const a = (over: Partial<AgentDefinition> & { id: string }): AgentDefinition => ({
  name: over.id,
  description: 'd',
  systemPrompt: `prompt-${over.id}`,
  toolScope: 'all',
  maxIterations: 25,
  ...over,
})

afterEach(cleanup)

describe('OrgTree', () => {
  it('renders children nested inside their parent (multi-level parentId)', () => {
    render(
      <OrgTree
        agents={[
          a({ id: 'ceo', name: 'CEO', role: 'ceo' }),
          a({ id: 'pm', name: 'PM', parentId: 'ceo' }),
          a({ id: 'engineer', name: 'Engineer', parentId: 'pm' }),
        ]}
        expanded={null}
        onToggle={() => {}}
      />
    )
    const pmItem = screen.getByText('PM').closest('li') as HTMLElement
    expect(within(pmItem).getByText('Engineer')).toBeInTheDocument()
    const ceoItem = screen.getByText('CEO').closest('li') as HTMLElement
    expect(within(ceoItem).getByText('PM')).toBeInTheDocument()
  })

  it('reproduces CEO -> head -> members from team/teamRole when parentId is absent', () => {
    render(
      <OrgTree
        agents={[
          a({ id: 'ceo', name: 'CEO', role: 'ceo' }),
          a({ id: 'pm', name: 'PM', role: 'pm', team: 'dev', teamRole: 'head' }),
          a({ id: 'engineer', name: 'Engineer', role: 'engineer', team: 'dev' }),
        ]}
        expanded={null}
        onToggle={() => {}}
      />
    )
    const pmItem = screen.getByText('PM').closest('li') as HTMLElement
    expect(within(pmItem).getByText('Engineer')).toBeInTheDocument()
  })

  it('shows the first 3 capabilities plus a "+N more" affordance', () => {
    render(
      <OrgTree
        agents={[a({ id: 'x', name: 'X', capabilities: ['c1', 'c2', 'c3', 'c4', 'c5'] })]}
        expanded={null}
        onToggle={() => {}}
      />
    )
    expect(screen.getByText('c1')).toBeInTheDocument()
    expect(screen.getByText('c3')).toBeInTheDocument()
    expect(screen.queryByText('c4')).not.toBeInTheDocument()
    expect(screen.getByText('+2 more')).toBeInTheDocument()
  })

  it('renders a team-less childless non-CEO agent under Independent Agents', () => {
    render(
      <OrgTree
        agents={[
          a({ id: 'ceo', name: 'CEO', role: 'ceo' }),
          a({ id: 'researcher', name: 'Researcher', role: 'researcher' }),
        ]}
        expanded={null}
        onToggle={() => {}}
      />
    )
    const group = screen.getByText('Independent Agents').closest('div') as HTMLElement
    expect(within(group).getByText('Researcher')).toBeInTheDocument()
  })
})

describe('OrgTreeView', () => {
  it('shows the selected agent detail on click and hides it on a second click', () => {
    render(<OrgTreeView agents={[a({ id: 'pm', name: 'PM' })]} />)
    // Use start-anchor regex to avoid matching "Edit PM" / "Delete PM" action buttons.
    const card = (): HTMLElement => screen.getByRole('button', { name: /^PM/ })
    expect(screen.queryByText('prompt-pm')).not.toBeInTheDocument()
    fireEvent.click(card())
    expect(screen.getByText('prompt-pm')).toBeInTheDocument()
    fireEvent.click(card())
    expect(screen.queryByText('prompt-pm')).not.toBeInTheDocument()
  })
})

describe('OrgTreeView delegation highlight', () => {
  const li = (over: Partial<AgentDefinition> & { id: string }) => ({
    name: over.id,
    description: 'd',
    systemPrompt: '',
    toolScope: 'all' as const,
    maxIterations: 25,
    builtin: false,
    ...over,
  })

  it('highlights the selected agent\'s delegation targets and shows its chips', () => {
    render(
      <OrgTreeView
        agents={[
          li({ id: 'pm', name: 'PM', team: 'dev', teamRole: 'head', systemPrompt: "find_agents({ role: 'engineer' })" }),
          li({ id: 'engineer', name: 'Engineer', role: 'engineer', team: 'dev' }),
        ]}
      />
    )
    // Select PM (its node card button; /^PM/ avoids matching the "Edit PM"/"Delete PM" action buttons).
    fireEvent.click(screen.getByRole('button', { name: /^PM/ }))
    // Engineer node is marked as a delegation target.
    // Use getAllByText because DelegationLinks also renders an "Engineer" chip.
    const engCard = screen
      .getAllByText('Engineer')
      .map((el) => el.closest('[data-delegation-target]'))
      .find(Boolean) as HTMLElement
    expect(engCard).toHaveAttribute('data-delegation-target', 'true')
    // The chips row appears.
    expect(screen.getByText('Delegates to')).toBeInTheDocument()
  })
})

describe('OrgTreeView CRUD affordances', () => {
  const li = (over: Partial<AgentDefinition> & { id: string; builtin: boolean }) => ({
    name: over.id,
    description: 'd',
    systemPrompt: 'p',
    toolScope: 'all' as const,
    maxIterations: 25,
    ...over,
  })

  it('shows Edit + Delete on a user agent and only Duplicate on a builtin', () => {
    render(<OrgTreeView agents={[li({ id: 'user', name: 'User', builtin: false }), li({ id: 'bi', name: 'BI', builtin: true })]} />)
    const userCard = screen.getByText('User').closest('li') as HTMLElement
    const biCard = screen.getByText('BI').closest('li') as HTMLElement
    expect(within(userCard).getByLabelText(/edit/i)).toBeInTheDocument()
    expect(within(userCard).getByLabelText(/delete/i)).toBeInTheDocument()
    expect(within(biCard).queryByLabelText(/delete/i)).not.toBeInTheDocument()
    expect(within(biCard).getByLabelText(/duplicate/i)).toBeInTheDocument()
  })

  it('clicking New opens the form sheet', () => {
    render(<OrgTreeView agents={[li({ id: 'user', name: 'User', builtin: false })]} />)
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }))
    expect(screen.getByText('New agent')).toBeInTheDocument()
  })
})
