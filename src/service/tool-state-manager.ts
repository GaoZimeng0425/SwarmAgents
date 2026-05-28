export type ToolStateManager = {
  sessionId: string
  getOrCreateBrowserContext(): Promise<unknown>
  saveCookies(cookies: unknown[]): Promise<void>
  loadCookies(): Promise<unknown[]>
  dispose(): Promise<void>
}

export function createToolStateManager(_sessionId: string): ToolStateManager {
  return {
    sessionId: _sessionId,
    getOrCreateBrowserContext: async () => { throw new Error('ToolStateManager: Playwright not yet wired') },
    saveCookies: async () => {},
    loadCookies: async () => [],
    dispose: async () => {},
  }
}
