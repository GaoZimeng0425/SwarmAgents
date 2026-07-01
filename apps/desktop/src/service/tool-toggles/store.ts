// In-memory state machine over a plaintext `tool-toggles.json`. Holds the
// app-wide disabled sets for built-in tool groups and skills (MCP lives in its
// own config). Loads forgivingly on construction; each mutator persists then
// returns the new state. Sync IO mirrors the sibling skill store.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from '@shared/logger'
import { type ToolToggles, ToolTogglesSchema } from '@swarm/protocol'

const log = createLogger({ process: 'service' }).child({ component: 'tool-toggles' })

export type ToolTogglesStore = {
  get(): ToolToggles
  setSkillEnabled(name: string, enabled: boolean): ToolToggles
  setToolGroupEnabled(group: string, enabled: boolean): ToolToggles
  isSkillEnabled(name: string): boolean
  isGroupEnabled(group: string): boolean
}

const empty = (): ToolToggles => ({ disabledSkills: [], disabledToolGroups: [] })

export function createToolTogglesStore(opts: { filePath: string }): ToolTogglesStore {
  const { filePath } = opts
  let state: ToolToggles = empty()

  if (existsSync(filePath)) {
    try {
      const parsed = ToolTogglesSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')))
      if (parsed.success) state = parsed.data
      else log.warn({ msg: 'tool-toggles.json failed schema; using defaults', err: parsed.error.message })
    } catch (err) {
      log.warn({ msg: 'tool-toggles.json unreadable; using defaults', err: String(err) })
    }
  }

  const persist = (next: ToolToggles): ToolToggles => {
    state = next
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`)
    } catch (err) {
      log.error({ msg: 'failed to persist tool-toggles', err: err instanceof Error ? err.message : String(err) })
    }
    return next
  }

  // Toggle membership in a disabled list: enabled=false adds, enabled=true removes.
  const apply = (list: string[], name: string, enabled: boolean): string[] =>
    enabled ? list.filter((n) => n !== name) : list.includes(name) ? list : [...list, name]

  return {
    get: () => ({
      ...state,
      disabledSkills: [...state.disabledSkills],
      disabledToolGroups: [...state.disabledToolGroups],
    }),

    setSkillEnabled(name, enabled) {
      log.info({ msg: 'set skill enabled', name, enabled })
      return persist({ ...state, disabledSkills: apply(state.disabledSkills, name, enabled) })
    },

    setToolGroupEnabled(group, enabled) {
      log.info({ msg: 'set tool group enabled', group, enabled })
      return persist({ ...state, disabledToolGroups: apply(state.disabledToolGroups, group, enabled) })
    },

    isSkillEnabled: (name) => !state.disabledSkills.includes(name),
    isGroupEnabled: (group) => !state.disabledToolGroups.includes(group),
  }
}
