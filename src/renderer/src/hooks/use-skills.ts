import { useEffect, useState } from 'react'
import type { Skill } from '@shared/types/skill'

/** Loads the skill list and exposes a setter for mutation results to push into. */
export function useSkills(): {
  skills: Skill[]
  setSkills: (skills: Skill[]) => void
} {
  const [skills, setSkills] = useState<Skill[]>([])
  useEffect(() => {
    void window.swarm.skills.list().then(setSkills)
  }, [])
  return { skills, setSkills }
}
