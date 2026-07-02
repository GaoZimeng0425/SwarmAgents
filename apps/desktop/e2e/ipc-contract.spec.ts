import { test, expect } from './fixtures'

// Case 4 — preload → main IPC contract sampling. Asserts return shapes for
// representative bridges; if any channel is renamed, this case fails.
test('IPC bridges return expected shapes', async ({ page }) => {
  const providers = await page.evaluate(
    () => (window as unknown as { swarm: { providers: { get: () => Promise<{ providers: unknown[] }> } } }).swarm.providers.get()
  )
  expect(Array.isArray(providers.providers)).toBe(true)

  const agents = await page.evaluate(
    () => (window as unknown as { swarm: { agents: { list: () => Promise<unknown[]> } } }).swarm.agents.list()
  )
  expect(Array.isArray(agents)).toBe(true)

  const budgets = await page.evaluate(
    () => (window as unknown as { swarm: { budgets: { get: () => Promise<Record<string, unknown>> } } }).swarm.budgets.get()
  )
  expect(budgets).toEqual(expect.any(Object))

  const mcp = await page.evaluate(
    () => (window as unknown as { swarm: { mcp: { list: () => Promise<unknown[]> } } }).swarm.mcp.list()
  )
  expect(Array.isArray(mcp)).toBe(true)
})
