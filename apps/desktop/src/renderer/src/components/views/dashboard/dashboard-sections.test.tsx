// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

// RunningCards takes no router (unlike ScheduledList/RecentList, which call
// useNavigate() and render async through RouterProvider in this env), so it's
// used here to assert the shared DashboardEmpty replaced the old dashed box.
import { RunningCards } from './running-cards'

afterEach(cleanup)

describe('dashboard section empty states', () => {
  it('RunningCards empty renders the DashboardEmpty copy in a solid card (no dashed border)', () => {
    const { container } = render(<RunningCards awaiting={[]} running={[]} />)
    expect(screen.getByText(/暂无运行中的任务/)).toBeInTheDocument()
    expect(container.querySelector('.border-dashed')).toBeNull()
  })
})
