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
    render(<AgentFormSheet agents={[existing]} mode="create" onOpenChange={() => {}} onSubmit={onSubmit} open />)
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
      maxIterations: 25,
    })
  })

  it('edit mode: prefills fields and makes id read-only', () => {
    render(
      <AgentFormSheet
        agent={existing}
        agents={[existing]}
        mode="edit"
        onOpenChange={() => {}}
        onSubmit={() => {}}
        open
      />
    )
    expect(screen.getByLabelText('name')).toHaveValue('PM')
    expect(screen.getByLabelText('id')).toHaveAttribute('readonly')
  })

  it('parentId dropdown lists other agents and excludes the edited agent', () => {
    render(
      <AgentFormSheet
        agent={existing}
        agents={[existing, { ...existing, id: 'eng', name: 'Eng' }]}
        mode="edit"
        onOpenChange={() => {}}
        onSubmit={() => {}}
        open
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
    render(<AgentFormSheet agents={[]} mode="create" onOpenChange={() => {}} onSubmit={onSubmit} open />)
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

  it('toggling "Authoring" sets authoring: true on submit', () => {
    const onSubmit = vi.fn()
    render(<AgentFormSheet agents={[]} mode="create" onOpenChange={() => {}} onSubmit={onSubmit} open />)
    fireEvent.change(screen.getByLabelText('id'), { target: { value: 'author' } })
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Author' } })
    fireEvent.change(screen.getByLabelText('description'), { target: { value: 'writes agents' } })
    fireEvent.change(screen.getByLabelText('system prompt'), { target: { value: 'author it' } })
    fireEvent.click(screen.getByRole('switch', { name: /authoring/i }))
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ authoring: true })
  })

  it('prefills Authoring from a legacy agent with toolScope "authoring" (no flag)', () => {
    const legacy: AgentDefinition = { ...existing, id: 'legacy-author', toolScope: 'authoring' }
    render(
      <AgentFormSheet agent={legacy} agents={[legacy]} mode="edit" onOpenChange={() => {}} onSubmit={() => {}} open />
    )
    expect(screen.getByRole('switch', { name: /authoring/i })).toHaveAttribute('aria-checked', 'true')
  })
})
