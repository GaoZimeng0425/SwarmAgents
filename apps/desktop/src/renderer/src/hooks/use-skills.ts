import { useCallback, useEffect, useState } from 'react'
import type { Skill } from '@swarm/protocol'

/** Loads the skill list (each annotated with its enabled state) and exposes a
 * setter for mutation results plus a reload to refresh after an enable toggle. */
export function useSkills(): {
  skills: Skill[]
  setSkills: (skills: Skill[]) => void
  reload: () => void
} {
  const [skills, setSkills] = useState<Skill[]>([])
  const reload = useCallback(() => {
    void window.swarm.skills.list().then(setSkills)
  }, [])
  useEffect(reload, [reload])
  // Live-refresh when the skills dir changes on disk (the service watches it).
  useEffect(
    () =>
      window.swarm.subscribeEvents((e) => {
        if (e.kind === 'skills.changed') reload()
      }),
    [reload]
  )
  return { skills, setSkills, reload }
}
