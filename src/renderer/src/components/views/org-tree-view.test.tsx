// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import type { AgentDefinition } from '@shared/types/agent'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { OrgTree, OrgTreeView } from './org-tree-view'

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
    const card = (): HTMLElement => screen.getByRole('button', { name: /PM/ })
    expect(screen.queryByText('prompt-pm')).not.toBeInTheDocument()
    fireEvent.click(card())
    expect(screen.getByText('prompt-pm')).toBeInTheDocument()
    fireEvent.click(card())
    expect(screen.queryByText('prompt-pm')).not.toBeInTheDocument()
  })
})
