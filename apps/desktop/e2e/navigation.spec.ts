import { test, expect } from './fixtures'

// Case 6 — after a submit, a session is persisted (IPC) and appears in the
// sidebar. The durable contract is "submit creates a session the sidebar shows".
// The click-into-detail verifies REAL navigation: from the home route back to
// /session/$sessionId by clicking a sidebar item, with TasksView mounting.
//
// Sidebar DOM (apps/desktop/src/renderer/src/components/session-list.tsx:308):
// each session row is a <button> whose accessible name is the session title
// (rendered in a child <span>, session-list.tsx:308). The backend seeds a
// fresh session's title from the first goal, so the row's accessible name is
// exactly the submitted goal text — stable and unique per test run.
// Detail route (apps/desktop/src/renderer/src/routes/session.$sessionId.tsx:41)
// mounts <TasksView>; we assert the URL changed to /session/<id> rather than a
// TasksView-internal node, since TasksView has no stable test id of its own.
const GOAL = 'nav test goal'
test('submit creates a session visible in the sidebar', async ({ page }) => {
  await page.evaluate(async () => {
    const w = (window as unknown as {
      swarm: {
        providers: {
          setKey: (id: string, key: string) => Promise<unknown>
          setActive: (id: string | null) => Promise<unknown>
        }
      }
    }).swarm
    await w.providers.setKey('anthropic', 'sk-e2e-dummy')
    await w.providers.setActive('anthropic')
  })
  await expect(page.getByText('No API key configured')).toBeHidden()

  await page.locator('textarea').first().fill(GOAL)
  await page.getByRole('button', { name: 'Submit' }).click()

  // Session is persisted via IPC.
  const sessions = await page.evaluate(() =>
    (window as unknown as {
      swarm: { sessions: { list: () => Promise<Array<{ id: string; taskCount: number }>> }
      }
    }).swarm.sessions.list(),
  )
  expect(sessions.length).toBeGreaterThan(0)

  // The sidebar shows the freshly created session. The session title is seeded
  // from the goal, so the row button's accessible name is the goal text itself.
  const sessionItem = page.getByRole('button', { name: GOAL }).first()
  await expect(sessionItem).toBeVisible({ timeout: 10_000 })

  // Click-into-detail: drive REAL navigation. submitGoal already selected the
  // session (and the URL reflects it), so first navigate back to the home route
  // via the router to make the sidebar click observable. Routing is hash-based
  // (createHashHistory, entries/main.tsx:21), so the URL looks like
  // .../index.html#/session/<id>; we assert on the hash portion.
  await page.evaluate(() => (window.location.hash = '#/'))
  await expect(page).toHaveURL(/#\/$/)

  await sessionItem.click()
  await expect(page).toHaveURL(/#\/session\//)
})
