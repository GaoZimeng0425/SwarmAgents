import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@shared/logger'
import { type Skill, type SkillMutationResult, SkillSchema } from '@shared/types/skill'
import { parse as parseYaml } from 'yaml'

const log = createLogger({ process: 'service' }).child({ component: 'skills' })

export type SkillStore = {
  list(): Skill[]
  get(name: string): Skill | undefined
  reload(): void
  save(skill: Skill): SkillMutationResult
  remove(name: string): SkillMutationResult
}

/**
 * Parse `--- <yaml> ---` frontmatter + body, mirroring pi-agent-core's loader:
 * real YAML frontmatter, body trimmed, `disable-model-invocation` honored.
 */
export function parseSkill(raw: string, fallbackName: string): Skill {
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw.replace(/\r\n?/g, '\n'))
  if (!fm) return { name: fallbackName, description: fallbackName, body: raw.trim() }
  let meta: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(fm[1])
    if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>
  } catch {
    // Malformed frontmatter: fall back to the folder name + raw body below.
  }
  const skill: Skill = {
    name: typeof meta.name === 'string' && meta.name ? meta.name : fallbackName,
    description: typeof meta.description === 'string' && meta.description ? meta.description : fallbackName,
    body: fm[2].trim(),
  }
  if (meta['disable-model-invocation'] === true) skill.disableModelInvocation = true
  return skill
}

export function serializeSkill(skill: Skill): string {
  const flag = skill.disableModelInvocation ? 'disable-model-invocation: true\n' : ''
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n${flag}---\n\n${skill.body.trim()}\n`
}

export function createSkillStore(opts: { dir: string }): SkillStore {
  const { dir } = opts
  let skills: Skill[] = []

  const reload = (): void => {
    skills = []
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(dir, entry.name, 'SKILL.md')
      if (!existsSync(file)) continue
      try {
        skills.push({ ...parseSkill(readFileSync(file, 'utf8'), entry.name), filePath: file })
      } catch (err) {
        log.warn({ msg: 'failed to parse skill', dir: entry.name, err: String(err) })
      }
    }
  }

  reload()

  const save: SkillStore['save'] = (skill) => {
    const parsed = SkillSchema.safeParse(skill)
    if (!parsed.success)
      return { ok: false, code: 'invalid', message: parsed.error.issues[0]?.message ?? 'invalid skill' }
    try {
      const folder = join(dir, parsed.data.name)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'SKILL.md'), serializeSkill(parsed.data))
    } catch (err) {
      return { ok: false, code: 'write_failed', message: String(err) }
    }
    reload()
    return { ok: true, skills: [...skills] }
  }

  const remove: SkillStore['remove'] = (name) => {
    const folder = join(dir, name)
    if (!existsSync(folder)) return { ok: false, code: 'not_found', message: `skill "${name}" not found` }
    try {
      rmSync(folder, { recursive: true, force: true })
    } catch (err) {
      return { ok: false, code: 'delete_failed', message: String(err) }
    }
    reload()
    return { ok: true, skills: [...skills] }
  }

  return {
    list: () => [...skills],
    get: (name) => skills.find((s) => s.name === name),
    reload,
    save,
    remove,
  }
}
