// Plaintext on-disk quick-panel config store. Reads/writes a single JSON file.
// Same pattern as web-search/store.ts: atomic write (tmp → rename), forgiving
// load (returns defaults on missing/corrupt file).
import { existsSync, promises as fs } from 'node:fs'

export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space'

export type QuickPanelConfig = {
  hotkey: string
}

export type QuickPanelStore = {
  load(): Promise<QuickPanelConfig>
  save(config: QuickPanelConfig): Promise<void>
}

function defaultConfig(): QuickPanelConfig {
  return { hotkey: DEFAULT_HOTKEY }
}

export function createQuickPanelStore(opts: { filePath: string }): QuickPanelStore {
  const { filePath } = opts

  const load = async (): Promise<QuickPanelConfig> => {
    if (!existsSync(filePath)) return defaultConfig()
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
      if (typeof parsed?.hotkey === 'string') return { hotkey: parsed.hotkey }
      return defaultConfig()
    } catch {
      return defaultConfig()
    }
  }

  // Serialize saves so concurrent calls don't race on the shared .tmp path.
  let saveQueue: Promise<void> = Promise.resolve()

  const save = (config: QuickPanelConfig): Promise<void> => {
    const next = saveQueue.then(async () => {
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`)
      await fs.rename(tmp, filePath)
    })
    saveQueue = next.catch(() => undefined)
    return next
  }

  return { load, save }
}
