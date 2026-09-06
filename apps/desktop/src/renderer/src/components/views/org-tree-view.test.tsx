// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { AgentDefinition } from '@swarm/protocol'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { OrgTree } from './org-tree-view'

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

  it('shows an "authoring" badge for authoring agents, including legacy toolScope back-compat', () => {
    render(
      <OrgTree
        agents={[
          a({ id: 'flag', name: 'Flag', authoring: true }),
          a({ id: 'legacy', name: 'Legacy', toolScope: 'authoring' }),
          a({ id: 'plain', name: 'Plain' }),
        ]}
        expanded={null}
        onToggle={() => {}}
      />
    )
    expect(within(screen.getByText('Flag').closest('li') as HTMLElement).getByText('authoring')).toBeInTheDocument()
    expect(within(screen.getByText('Legacy').closest('li') as HTMLElement).getByText('authoring')).toBeInTheDocument()
    expect(
      within(screen.getByText('Plain').closest('li') as HTMLElement).queryByText('authoring')
    ).not.toBeInTheDocument()
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
