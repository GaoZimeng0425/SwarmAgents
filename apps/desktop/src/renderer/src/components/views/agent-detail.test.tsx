// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { AgentDefinition } from '@swarm/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentDetail } from './agent-detail'

const agent: AgentDefinition = {
  id: 'pm',
  name: 'Product Manager',
  description: 'Plans the work.',
  systemPrompt: 'You are the PM.',
  toolScope: 'all',
  maxIterations: 25,
}

afterEach(cleanup)

describe('AgentDetail', () => {
  it('shows the name, id, description and system prompt', () => {
    render(<AgentDetail agent={agent} />)
    expect(screen.getByText('Product Manager')).toBeInTheDocument()
    expect(screen.getByText('pm')).toBeInTheDocument()
    expect(screen.getByText('Plans the work.')).toBeInTheDocument()
    expect(screen.getByText('You are the PM.')).toBeInTheDocument()
  })
})
