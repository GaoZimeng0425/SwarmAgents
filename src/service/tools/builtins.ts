import type { WebSearchInjection } from '@shared/types/web-search'

import type { CronScheduler } from '../cron-scheduler'
import type { MemoryStore } from '../memory-store'
import type { SkillStore } from '../skills/store'
import { askUserSpec } from './ask'
import { cronSpecs } from './cron'
import { fsSpecs } from './fs'
import { memorySpecs } from './memory'
import { buildPeekabooTools } from './peekaboo'
import { updatePlanSpec } from './plan'
import type { ToolRegistry, ToolRisk, ToolSpec } from './registry'
import { renderUiSpec } from './render-ui'
import { shellSpec } from './shell'
import { useSkillSpec } from './skill'
import { spawnAgentSpec } from './spawn'
import { webFetchSpec, webSearchSpec } from './web'

const PEEKABOO_RISK: Record<string, ToolRisk> = {
  // Read-only observation and the reversible scroll auto-run; consequential
  // interactions (click/type/hotkey) escalate to the permission prompt.
  see_screen: 'low',
  list_apps: 'low',
  scroll: 'low',
  click: 'high',
  type: 'high',
  hotkey: 'high',
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

export function registerBuiltinTools(
  registry: ToolRegistry,
  deps?: {
    memoryStore?: MemoryStore
    skillStore?: SkillStore
    scheduler?: CronScheduler
    getWebSearchConfig?: () => WebSearchInjection
  }
): void {
  for (const spec of peekabooSpecs()) registry.register(spec)
  registry.register(spawnAgentSpec())
  registry.register(updatePlanSpec())
  registry.register(askUserSpec())
  registry.register(renderUiSpec())
  registry.register(shellSpec())
  registry.register(webFetchSpec())
  // No config getter (e.g. tests) → 'auto' with env-var fallback inside web.ts.
  registry.register(webSearchSpec(deps?.getWebSearchConfig ?? (() => ({ provider: 'auto' }))))
  for (const spec of fsSpecs()) registry.register(spec)
  // Memory tools need a backing store; registered only when one is injected.
  if (deps?.memoryStore) for (const spec of memorySpecs(deps.memoryStore)) registry.register(spec)
  // use_skill needs the skill store; registered only when one is injected.
  if (deps?.skillStore) registry.register(useSkillSpec(deps.skillStore))
  // Cron tools need the scheduler; registered only when one is injected.
  if (deps?.scheduler) for (const spec of cronSpecs(deps.scheduler)) registry.register(spec)
}
