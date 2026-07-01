// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type { AgentDefinition } from '@swarm/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DelegationLinks } from './delegation-links'

const agents: AgentDefinition[] = [
  { id: 'ceo', name: 'CEO', description: 'd', systemPrompt: '', toolScope: 'all', maxIterations: 25 },
  { id: 'pm', name: 'PM', description: 'd', systemPrompt: '', toolScope: 'all', maxIterations: 25 },
  { id: 'eng', name: 'Engineer', description: 'd', systemPrompt: '', toolScope: 'all', maxIterations: 25 },
]
const edges = [
  { from: 'ceo', to: 'pm' },
  { from: 'pm', to: 'eng' },
]

afterEach(cleanup)

describe('DelegationLinks', () => {
  it('shows Delegates to (outgoing) and Called by (incoming) chips', () => {
    render(<DelegationLinks agentId="pm" agents={agents} edges={edges} onSelect={() => {}} />)
    expect(screen.getByText('Delegates to')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Engineer' })).toBeInTheDocument() // pm -> eng
    expect(screen.getByText('Called by')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'CEO' })).toBeInTheDocument() // ceo -> pm
  })

  it('clicking a chip calls onSelect with the target id', () => {
    const onSelect = vi.fn()
    render(<DelegationLinks agentId="pm" agents={agents} edges={edges} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'Engineer' }))
    expect(onSelect).toHaveBeenCalledWith('eng')
  })

  it('renders nothing when the agent has no edges', () => {
    const { container } = render(
      <DelegationLinks agentId="eng-with-no-out" agents={agents} edges={[]} onSelect={() => {}} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
