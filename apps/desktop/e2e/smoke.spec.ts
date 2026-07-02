import { test, expect } from './fixtures'

// Case 1 — smoke: validates build chain, electron runtime loading
// better-sqlite3 + sqlite-vec, single-instance bypass, and window creation.
test('app boots and renders the composer', async ({ page }) => {
  await expect(page.locator('textarea').first()).toBeVisible()
})
