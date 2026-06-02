import { buildPeekabooTools } from './peekaboo'
import type { ToolRegistry, ToolRisk, ToolSpec } from './registry'
import { shellSpec } from './shell'
import { spawnAgentSpec } from './spawn'

const PEEKABOO_RISK: Record<string, ToolRisk> = {
  see_screen: 'low',
  list_apps: 'low',
}

export function peekabooSpecs(): ToolSpec[] {
  // Peekaboo executors ignore deps (permission is enforced centrally in
  // beforeToolCall), so building once at registration is safe — the tool
  // objects are reused across runs.
  const tools = buildPeekabooTools({
    send: () => undefined,
    requestPermission: () => Promise.resolve('grant' as const),
  })
  return tools.map((tool) => ({
    group: 'peekaboo',
    name: tool.name,
    risk: PEEKABOO_RISK[tool.name] ?? 'medium',
    source: 'builtin' as const,
    build: () => tool,
  }))
}

export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const spec of peekabooSpecs()) registry.register(spec)
  registry.register(spawnAgentSpec())
  registry.register(shellSpec())
}
