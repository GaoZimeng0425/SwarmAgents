import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@shared/logger'
import { type AgentDefinition, AgentDefinitionSchema } from '@shared/types/agent'
import { parse as parseYaml } from 'yaml'

const log = createLogger({ process: 'service' }).child({ component: 'agents' })

export type AgentMutationResult = { ok: true; agents: AgentDefinition[] } | { ok: false; code: string; message: string }

export type AgentStore = {
  list(): AgentDefinition[]
  get(id: string): AgentDefinition | undefined
  reload(): void
  save(def: AgentDefinition): AgentMutationResult
  remove(id: string): AgentMutationResult
}

/**
 * Parse `--- <yaml> ---` frontmatter (structured fields) + body (the systemPrompt),
 * mirroring the skill store's loader. `id` comes from the folder name, not the
 * frontmatter. Returns undefined when the result is not a valid AgentDefinition so
 * the caller can warn + skip a malformed file.
 */
export function parseAgent(raw: string, id: string): AgentDefinition | undefined {
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw.replace(/\r\n?/g, '\n'))
  let meta: Record<string, unknown> = {}
  let body = raw.trim()
  if (fm) {
    try {
      const parsed = parseYaml(fm[1])
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>
    } catch {
      // Malformed frontmatter: schema validation below rejects it.
    }
    body = fm[2].trim()
  }
  const result = AgentDefinitionSchema.safeParse({
    id,
    name: meta.name,
    description: meta.description,
    systemPrompt: body,
    toolScope: meta.toolScope,
    role: meta.role,
    capabilities: meta.capabilities,
    team: meta.team,
    teamRole: meta.teamRole,
    parentId: meta.parentId,
    maxIterations: meta.maxIterations,
    model: meta.model,
  })
  return result.success ? result.data : undefined
}

export function serializeAgent(def: AgentDefinition): string {
  // JSON.stringify keeps string values valid YAML even with colons/commas.
  const lines = [
    `name: ${JSON.stringify(def.name)}`,
    `description: ${JSON.stringify(def.description)}`,
    `toolScope: ${def.toolScope}`,
    `maxIterations: ${def.maxIterations}`,
  ]
  if (def.role) lines.push(`role: ${JSON.stringify(def.role)}`)
  if (def.capabilities?.length) lines.push(`capabilities: ${JSON.stringify(def.capabilities)}`)
  if (def.team) lines.push(`team: ${JSON.stringify(def.team)}`)
  if (def.teamRole) lines.push(`teamRole: ${JSON.stringify(def.teamRole)}`)
  if (def.parentId) lines.push(`parentId: ${JSON.stringify(def.parentId)}`)
  if (def.model) lines.push(`model: ${JSON.stringify(def.model)}`)
  return `---\n${lines.join('\n')}\n---\n\n${def.systemPrompt.trim()}\n`
}

export function createAgentStore(opts: { dir: string; builtins?: AgentDefinition[] }): AgentStore {
  const { dir } = opts
  const builtins = opts.builtins ?? []
  let agents: AgentDefinition[] = []

  // Built-ins ship with the app and are always available; a user agent of the
  // same id overrides its built-in.
  const merged = (): AgentDefinition[] => {
    const userIds = new Set(agents.map((a) => a.id))
    return [...builtins.filter((b) => !userIds.has(b.id)), ...agents]
  }

  const reload = (): void => {
    agents = []
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(dir, entry.name, 'AGENT.md')
      if (!existsSync(file)) continue
      const parsed = parseAgent(readFileSync(file, 'utf8'), entry.name)
      if (parsed) agents.push(parsed)
      else log.warn({ msg: 'failed to parse agent', dir: entry.name })
    }
  }

  reload()

  const save: AgentStore['save'] = (def) => {
    const parsed = AgentDefinitionSchema.safeParse(def)
    if (!parsed.success)
      return { ok: false, code: 'invalid', message: parsed.error.issues[0]?.message ?? 'invalid agent' }
    // parentId is a structural edge; reject self-reference, dangling targets,
    // and cycles so the org tree is always a forest. Resolve against the
    // current agents with the incoming def overlaid (it is not yet on disk).
    const { parentId, id } = parsed.data
    if (parentId) {
      if (parentId === id) return { ok: false, code: 'self_parent', message: 'an agent cannot be its own parent' }
      const byId = new Map(merged().map((a) => [a.id, a]))
      byId.set(id, parsed.data)
      if (!byId.has(parentId)) return { ok: false, code: 'unknown_parent', message: `parent "${parentId}" does not exist` }
      const visited = new Set<string>([id])
      let cursor = parentId
      while (cursor) {
        if (visited.has(cursor)) return { ok: false, code: 'cycle', message: 'parent chain forms a cycle' }
        visited.add(cursor)
        cursor = byId.get(cursor)?.parentId ?? ''
      }
    }
    try {
      const folder = join(dir, parsed.data.id)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'AGENT.md'), serializeAgent(parsed.data))
    } catch (err) {
      return { ok: false, code: 'write_failed', message: String(err) }
    }
    reload()
    return { ok: true, agents: merged() }
  }

  const remove: AgentStore['remove'] = (id) => {
    const folder = join(dir, id)
    if (!existsSync(folder)) return { ok: false, code: 'not_found', message: `agent "${id}" not found` }
    try {
      rmSync(folder, { recursive: true, force: true })
    } catch (err) {
      return { ok: false, code: 'delete_failed', message: String(err) }
    }
    reload()
    return { ok: true, agents: merged() }
  }

  return {
    list: () => merged(),
    get: (id) => agents.find((a) => a.id === id) ?? builtins.find((b) => b.id === id),
    reload,
    save,
    remove,
  }
}
