// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type { AgentDefinition } from '@swarm/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentFormSheet } from './agent-form-sheet'

const existing: AgentDefinition = {
  id: 'pm',
  name: 'PM',
  description: 'plans',
  systemPrompt: 'be the pm',
  toolScope: 'all',
  maxIterations: 25,
}

afterEach(cleanup)

describe('AgentFormSheet', () => {
  it('create mode: assembles an AgentDefinition omitting empty optionals', () => {
    const onSubmit = vi.fn()
    render(
      <AgentFormSheet open mode="create" agents={[existing]} onSubmit={onSubmit} onOpenChange={() => {}} />
    )
    fireEvent.change(screen.getByLabelText('id'), { target: { value: 'helper' } })
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Helper' } })
    fireEvent.change(screen.getByLabelText('description'), { target: { value: 'helps' } })
    fireEvent.change(screen.getByLabelText('system prompt'), { target: { value: 'do help' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toEqual({
      id: 'helper',
      name: 'Helper',
      description: 'helps',
      systemPrompt: 'do help',
      toolScope: 'all',
      maxIterations: 25,
    })
  })

  it('edit mode: prefills fields and makes id read-only', () => {
    render(
      <AgentFormSheet open mode="edit" agent={existing} agents={[existing]} onSubmit={() => {}} onOpenChange={() => {}} />
    )
    expect(screen.getByLabelText('name')).toHaveValue('PM')
    expect(screen.getByLabelText('id')).toHaveAttribute('readonly')
  })

  it('parentId dropdown lists other agents and excludes the edited agent', () => {
    render(
      <AgentFormSheet
        open
        mode="edit"
        agent={existing}
        agents={[existing, { ...existing, id: 'eng', name: 'Eng' }]}
        onSubmit={() => {}}
        onOpenChange={() => {}}
      />
    )
    const parent = screen.getByLabelText('parent') as HTMLSelectElement
    const values = Array.from(parent.options).map((o) => o.value)
    expect(values).toContain('') // "(none)"
    expect(values).toContain('eng')
    expect(values).not.toContain('pm') // cannot parent to self
  })

  it('toggling "Team head" sets teamRole to head on submit', () => {
    const onSubmit = vi.fn()
    render(
      <AgentFormSheet open mode="create" agents={[]} onSubmit={onSubmit} onOpenChange={() => {}} />
    )
    fireEvent.change(screen.getByLabelText('id'), { target: { value: 'lead' } })
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Lead' } })
    fireEvent.change(screen.getByLabelText('description'), { target: { value: 'leads' } })
    fireEvent.change(screen.getByLabelText('system prompt'), { target: { value: 'lead it' } })
    fireEvent.change(screen.getByLabelText('team'), { target: { value: 'ui' } })
    // Use getByRole to get the switch specifically
    const switchElement = screen.getByRole('switch', { name: /team head/i })
    fireEvent.click(switchElement)
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ team: 'ui', teamRole: 'head' })
  })
})
