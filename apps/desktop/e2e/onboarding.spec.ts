import { expect, test } from './fixtures'

// Case 2 — empty state: no-provider banner is visible and opens settings
// to the providers tab.
test('no-provider banner opens settings to providers', async ({ page }) => {
  await expect(page.getByText('No API key configured')).toBeVisible()
  await page.getByRole('button', { name: 'Open Settings' }).click()
  await expect(page.getByPlaceholder('输入 API Key').first()).toBeVisible()
})

// Case 3 — entering a key persists it via the providers IPC. We assert
// through window.swarm.providers.get() to bypass UI state-sync timing.
//
// Note on trigger: the brief used `keyInput.press('Enter')`, but the
// KeyField input in providers-view.tsx has no onKeyDown/onBlur/<form>;
// the only setKey trigger is the "保存 Key" button's onClick. Clicking
// that button is therefore the correct action — the IPC assertion below
// (window.swarm.providers.get() → hasKey) is the real contract.
test('entering an API key persists via IPC', async ({ page }) => {
  await page.getByRole('button', { name: 'Open Settings' }).click()
  const keyInput = page.getByPlaceholder('输入 API Key').first()
  await keyInput.fill('sk-e2e-dummy')
  await page.getByRole('button', { name: '保存 Key' }).first().click()

  const state = await page.evaluate(() =>
    (
      window as unknown as { swarm: { providers: { get: () => Promise<{ providers: Array<{ hasKey: boolean }> }> } } }
    ).swarm.providers.get()
  )
  expect(state.providers.filter((p) => p.hasKey).length).toBeGreaterThan(0)
})
