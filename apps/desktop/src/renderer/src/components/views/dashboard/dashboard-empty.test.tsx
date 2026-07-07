// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Inbox } from 'lucide-react'
import { afterEach, describe, expect, it } from 'vitest'

import { DashboardEmpty } from './dashboard-empty'

afterEach(cleanup)

describe('DashboardEmpty', () => {
  it('renders the copy and a single solid card container (no dashed border)', () => {
    const { container } = render(<DashboardEmpty icon={Inbox}>暂无内容</DashboardEmpty>)
    expect(screen.getByText('暂无内容')).toBeInTheDocument()
    const card = container.firstElementChild as HTMLElement
    expect(card.className).toContain('rounded-2xl')
    expect(card.className).not.toContain('border-dashed')
  })
})
