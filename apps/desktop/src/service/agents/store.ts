import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@shared/logger'
import { type AgentDefinition, AgentDefinitionSchema } from '@swarm/protocol'
import { watch as chokidarWatch } from 'chokidar'
import { parse as parseYaml } from 'yaml'

export type { AgentMutationResult } from '@swarm/protocol'

import type { AgentMutationResult } from '@swarm/protocol'

const log = createLogger({ process: 'service' }).child({ component: 'agents' })

export type AgentStore = {
  list(): AgentDefinition[]
  get(id: string): AgentDefinition | undefined
  reload(): void
  save(def: AgentDefinition): AgentMutationResult
  remove(id: string): AgentMutationResult
  /**
   * Watch the agents dir for external edits (a folder dropped in by hand or by
   * the agent's fs tools). On a debounced change it reloads from disk, then
   * fires `onChange`. Returns a disposer. `fs.watch` is avoided deliberately —
   * no reliable recursive support and it floods on atomic saves; chokidar's
   * `awaitWriteFinish` only fires once a written AGENT.md has settled.
   */
  watch(onChange: () => void): () => void
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
    authoring: meta.authoring,
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
    `maxIterations: ${def.maxIterations}`,
  ]
  // toolScope is optional since the authoring-gate collapse; writing it
  // unconditionally serialized the literal "toolScope: undefined", which
  // parseAgent then rejected — silently wiping the agent on the next reload.
  if (def.toolScope) lines.push(`toolScope: ${def.toolScope}`)
  if (def.authoring) lines.push('authoring: true')
  if (def.role) lines.push(`role: ${JSON.stringify(def.role)}`)
  if (def.capabilities?.length) lines.push(`capabilities: ${JSON.stringify(def.capabilities)}`)
  if (def.team) lines.push(`team: ${JSON.stringify(def.team)}`)
  if (def.teamRole) lines.push(`teamRole: ${JSON.stringify(def.teamRole)}`)
  if (def.parentId) lines.push(`parentId: ${JSON.stringify(def.parentId)}`)
  if (def.model) lines.push(`model: ${JSON.stringify(def.model)}`)
  return `---\n${lines.join('\n')}\n---\n\n${def.systemPrompt.trim()}\n`
}

/**
 * Reconcile the on-disk builtin agents with the shipped defaults: upsert every
 * default (write when its file is missing or its content changed) and prune any
 * retired builtin's stale folder. User-authored agents — ids in neither `defs`
 * nor `retiredIds` — are left untouched. Idempotent: it writes only when content
 * differs, so it is a quiet no-op once disk matches code. Because it always
 * realigns builtins to code, a user's hand-edit or deletion of a builtin is
 * reverted on the next sync; to customize one, copy it under a new id.
 * Returns how many folders it wrote and removed.
 */
export function syncBuiltinAgents(
  dir: string,
  defs: AgentDefinition[],
  retiredIds: string[] = []
): { written: number; removed: number } {
  mkdirSync(dir, { recursive: true })
  let written = 0
  for (const def of defs) {
    const next = serializeAgent(def)
    const file = join(dir, def.id, 'AGENT.md')
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null
    if (current === next) continue
    mkdirSync(join(dir, def.id), { recursive: true })
    writeFileSync(file, next)
    written++
  }
  let removed = 0
  for (const id of retiredIds) {
    const folder = join(dir, id)
    if (!existsSync(folder)) continue
    rmSync(folder, { recursive: true, force: true })
    removed++
  }
  if (written || removed) log.info({ msg: 'synced builtin agents', dir, written, removed })
  return { written, removed }
}

export function createAgentStore(opts: { dir: string }): AgentStore {
  const { dir } = opts
  let agents: AgentDefinition[] = []

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
      const byId = new Map(agents.map((a) => [a.id, a]))
      byId.set(id, parsed.data)
      if (!byId.has(parentId))
        return { ok: false, code: 'unknown_parent', message: `parent "${parentId}" does not exist` }
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
    return { ok: true, agents }
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
    return { ok: true, agents }
  }

  const watch: AgentStore['watch'] = (onChange) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    // Coalesce the burst of events a folder copy produces into one reload.
    const onFsEvent = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        reload()
        log.info({ msg: 'agents dir changed; reloaded', count: agents.length })
        onChange()
      }, 250)
    }
    // depth 4 covers <name>/<bundled subdirs>/file without descending into a
    // pathological tree an agent might carry. ignoreInitial: the constructor
    // already did the first reload(), so skip the synthetic add events on start.
    const watcher = chokidarWatch(dir, {
      ignoreInitial: true,
      depth: 4,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    })
    watcher
      .on('add', onFsEvent)
      .on('change', onFsEvent)
      .on('unlink', onFsEvent)
      .on('addDir', onFsEvent)
      .on('unlinkDir', onFsEvent)
      .on('error', (err) =>
        log.error({ msg: 'agents watcher error', err: err instanceof Error ? err.message : String(err) })
      )
    log.info({ msg: 'watching agents dir', dir })
    return () => {
      if (timer) clearTimeout(timer)
      void watcher.close()
    }
  }

  return {
    list: () => agents,
    get: (id) => agents.find((a) => a.id === id),
    reload,
    save,
    remove,
    watch,
  }
}
