// src/main/calendar/store.ts
//
// Plaintext on-disk Calendar config store. Reads/writes a single JSON file.
// Saves are atomic (write tmp -> rename) and validated against the Zod schema
// before writing so we never persist garbage. Pure module: no logging, no
// globals - callers inject the filePath. Mirrors gmail/store.ts.
import { existsSync, promises as fs } from 'node:fs'
import { CalendarConfigOnDisk, defaultCalendarConfigOnDisk } from '@swarm/protocol'

export type Store = {
  load(): Promise<CalendarConfigOnDisk> // forgiving - returns defaults on missing/failure
  save(state: CalendarConfigOnDisk): Promise<void>
}

export function createStore(opts: { filePath: string }): Store {
  const { filePath } = opts

  const load: Store['load'] = async () => {
    if (!existsSync(filePath)) return defaultCalendarConfigOnDisk()
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
      const checked = CalendarConfigOnDisk.safeParse(parsed)
      return checked.success ? checked.data : defaultCalendarConfigOnDisk()
    } catch {
      return defaultCalendarConfigOnDisk()
    }
  }

  // Serialize saves so concurrent calls don't race on the shared .tmp path.
  let saveQueue: Promise<void> = Promise.resolve()
  const save: Store['save'] = (state) => {
    const next = saveQueue.then(async () => {
      CalendarConfigOnDisk.parse(state) // validate before writing
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
      await fs.rename(tmp, filePath)
    })
    saveQueue = next.catch(() => undefined)
    return next
  }

  return { load, save }
}
