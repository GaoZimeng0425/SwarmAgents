import { test, expect } from './fixtures'

// Case 5 — composer submits a goal and the user message renders. We seed a
// dummy provider key via IPC to unlock the composer, then drive the real UI.
// We do NOT wait for an LLM response (dummy key); we assert only that submit
// produces a task and the user message appears in the transcript.
test('composer submits and renders the user message', async ({ page }) => {
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

  // Banner disappears once providers state refreshes.
  await expect(page.getByText('No API key configured')).toBeHidden()

  await page.locator('textarea').first().fill('hello from e2e')
  await page.getByRole('button', { name: 'Submit' }).click()

  await expect(page.getByText('hello from e2e').first()).toBeVisible({ timeout: 15_000 })
})
