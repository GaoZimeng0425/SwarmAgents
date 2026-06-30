// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { VirtualList } from './virtual-list'

afterEach(() => {
  cleanup()
})

describe('VirtualList', () => {
  it('renders the ScrollArea root and the items', () => {
    render(
      <VirtualList
        className="h-[600px]"
        getKey={(s) => s}
        items={['alpha', 'beta', 'gamma']}
        renderItem={(s) => <div>{s}</div>}
      />,
    )
    // ScrollArea root is present (project convention: all scroll uses ScrollArea).
    expect(document.querySelector('[data-slot="scroll-area"]')).not.toBeNull()
    // test-setup.ts mocks offsetHeight=600 so react-virtual renders the rows.
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
    expect(screen.getByText('gamma')).toBeInTheDocument()
  })
})
