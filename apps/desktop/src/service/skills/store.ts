import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { createLogger } from '@shared/logger'
import { type Skill, type SkillMutationResult, SkillSchema } from '@swarm/protocol'
import { watch as chokidarWatch } from 'chokidar'
import { parse as parseYaml } from 'yaml'

const log = createLogger({ process: 'service' }).child({ component: 'skills' })

export type SkillStore = {
  list(): Skill[]
  get(name: string): Skill | undefined
  reload(): void
  save(skill: Skill): SkillMutationResult
  importFolder(sourceDir: string, overwrite?: boolean): SkillMutationResult
  remove(name: string): SkillMutationResult
  /**
   * Watch the skills dir for external edits (a folder dropped in by hand or by
   * the agent's fs tools). On a debounced change it reloads from disk, then
   * fires `onChange`. Returns a disposer. `fs.watch` is avoided deliberately —
   * no reliable recursive support and it floods on atomic saves; chokidar's
   * `awaitWriteFinish` only fires once a written SKILL.md has settled.
   */
  watch(onChange: () => void): () => void
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

/** All file paths under `root`, relative to it, POSIX-separated and sorted. */
function listFilesRel(root: string): string[] {
  const out: string[] = []
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const full = join(abs, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'))
    }
  }
  if (existsSync(root)) walk(root)
  return out.sort()
}

export function createSkillStore(opts: { dir: string; builtins?: Skill[] }): SkillStore {
  const { dir } = opts
  const builtins = opts.builtins ?? []
  let skills: Skill[] = []

  // Built-ins ship with the app and are always available; a user skill of the
  // same name overrides its built-in.
  const merged = (): Skill[] => {
    const userNames = new Set(skills.map((s) => s.name))
    return [...builtins.filter((b) => !userNames.has(b.name)), ...skills]
  }

  const reload = (): void => {
    skills = []
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const folder = join(dir, entry.name)
      const file = join(folder, 'SKILL.md')
      if (!existsSync(file)) continue
      try {
        skills.push({
          ...parseSkill(readFileSync(file, 'utf8'), entry.name),
          filePath: file,
          files: listFilesRel(folder),
        })
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
    return { ok: true, skills: merged() }
  }

  const importFolder: SkillStore['importFolder'] = (sourceDir, overwrite) => {
    log.info({ msg: 'importFolder start', sourceDir, overwrite: overwrite ?? false })
    const skillMd = join(sourceDir, 'SKILL.md')
    if (!existsSync(skillMd)) {
      log.warn({ msg: 'importFolder missing SKILL.md', sourceDir })
      return { ok: false, code: 'no_skill_md', message: 'The selected folder has no SKILL.md file.' }
    }
    let parsed: Skill
    try {
      parsed = parseSkill(readFileSync(skillMd, 'utf8'), basename(sourceDir))
    } catch (err) {
      log.error({ msg: 'importFolder read failed', sourceDir, err: String(err) })
      return { ok: false, code: 'invalid', message: 'Could not read SKILL.md.' }
    }
    const checked = SkillSchema.safeParse(parsed)
    if (!checked.success) {
      const message = checked.error.issues[0]?.message ?? 'invalid skill'
      log.warn({ msg: 'importFolder invalid skill', sourceDir, err: message })
      return { ok: false, code: 'invalid', message }
    }
    const target = join(dir, checked.data.name)
    if (existsSync(target) && !overwrite) {
      log.warn({ msg: 'importFolder name exists', name: checked.data.name })
      return { ok: false, code: 'exists', message: `A skill named "${checked.data.name}" already exists.` }
    }
    try {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      cpSync(sourceDir, target, { recursive: true })
    } catch (err) {
      log.error({ msg: 'importFolder copy failed', sourceDir, target, err: String(err) })
      return { ok: false, code: 'write_failed', message: String(err) }
    }
    reload()
    const fileCount = skills.find((s) => s.name === checked.data.name)?.files?.length ?? 0
    log.info({ msg: 'importFolder ok', name: checked.data.name, fileCount })
    return { ok: true, skills: merged() }
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
    return { ok: true, skills: merged() }
  }

  const watch: SkillStore['watch'] = (onChange) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    // Coalesce the burst of events a folder copy produces into one reload.
    const onFsEvent = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        reload()
        log.info({ msg: 'skills dir changed; reloaded', count: skills.length })
        onChange()
      }, 250)
    }
    // depth 4 covers <name>/<bundled subdirs>/file without descending into a
    // pathological tree a skill might carry. ignoreInitial: the constructor
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
        log.error({ msg: 'skills watcher error', err: err instanceof Error ? err.message : String(err) })
      )
    log.info({ msg: 'watching skills dir', dir })
    return () => {
      if (timer) clearTimeout(timer)
      void watcher.close()
    }
  }

  return {
    list: () => merged(),
    get: (name) => skills.find((s) => s.name === name) ?? builtins.find((b) => b.name === name),
    reload,
    save,
    importFolder,
    remove,
    watch,
  }
}
