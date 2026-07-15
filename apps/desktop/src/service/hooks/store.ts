// Read-only in-memory view of the hand-edited `hooks.json`. The service
// spawns the configured commands when the corresponding run.* events fire
// (see dispatcher.ts); there is no runtime mutation, so — unlike the sibling
// tool-toggles store — this one never persists and only exposes get().
// Loads forgivingly on construction: a missing or invalid file falls back to
// an empty config (no hooks fire) with a warn log.
import { existsSync, readFileSync } from 'node:fs'
import { createLogger } from '@shared/logger'
import { type HooksFile, HooksFileSchema } from '@swarm/protocol'

const log = createLogger({ process: 'service' }).child({ component: 'hooks-store' })

export type HooksStore = {
  get(): HooksFile
}

export function createHooksStore(opts: { filePath: string }): HooksStore {
  const { filePath } = opts
  let state: HooksFile = {}

  const load = (): HooksFile => {
    if (!existsSync(filePath)) return {}
    try {
      const parsed = HooksFileSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')))
      if (parsed.success) return parsed.data
      log.warn({ msg: 'hooks.json failed schema; no hooks will fire', err: parsed.error.message })
      return {}
    } catch (err) {
      log.warn({ msg: 'hooks.json unreadable; no hooks will fire', err: String(err) })
      return {}
    }
  }

  state = load()

  return {
    get: () => state,
  }
}
