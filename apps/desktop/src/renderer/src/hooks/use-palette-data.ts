// apps/desktop/src/renderer/src/hooks/use-palette-data.ts
// Gathers every renderer data source into the BuildInputs shape that
// buildItems (Task 3) consumes. Pure aggregation: no filtering/sorting logic
// of its own beyond the source-specific projections required to fit BuildInputs.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { swarmApi } from '../lib/api'
import type { BuildInputs } from '../lib/palette/build-items'
import { useSessionsStore } from '../stores/sessions'
import { useTeamOptions } from './use-agents'
import { useAllCronJobs } from './use-cron'
import { useMemory } from './use-memory'
import { useRuns } from './use-runs'
import { useSkills } from './use-skills'

// The mixed 「快捷入口」 group navigates to the four service routes. Hardcoded
// here (not in the store) because these are fixed app sections, not user data.
const SERVICES = [
  { id: 'bilibili', label: 'Bilibili', route: '/bilibili' },
  { id: 'gmail', label: 'Gmail', route: '/gmail' },
  { id: 'scheduled', label: '定时任务', route: '/scheduled' },
  { id: 'trending', label: '热点', route: '/trending' },
] as const

/** Gather every data source the palette needs into the BuildInputs shape. */
export function usePaletteData(): BuildInputs {
  const sessions = useSessionsStore((s) => s.sessions)
  const currentSessionId = useSessionsStore((s) => s.selectedSessionId)
  const allRuns = useRuns()
  const cron = useAllCronJobs()
  const formations = useTeamOptions()
  const memory = useMemory()
  const skills = useSkills()
  const artifacts = useQuery({
    queryKey: ['palette', 'artifacts'],
    queryFn: () => swarmApi.listArtifacts({ limit: 50 }),
    staleTime: 60_000,
  })

  return useMemo<BuildInputs>(
    () => ({
      sessions: sessions
        .filter((s) => !s.isSystem)
        .map((s) => ({ id: s.id, title: s.title, lastActiveAt: s.lastActiveAt, agentType: s.agentType })),
      currentSessionId,
      runningRuns: allRuns
        .filter((r) => r.status === 'running' || r.status === 'pending')
        .map((r) => ({
          id: r.id,
          sessionId: r.sessionId,
          goal: r.goal,
          status: r.status,
          summary: r.summary,
          plan: r.plan?.map((p) => ({ content: p.content, status: p.status })),
        })),
      // Cron source field is `lastRunAt`; BuildInputs renames it to `lastRun`.
      // lastStatus isn't on the source summary, so it stays null until a future
      // task wires it from CronRun history.
      cronJobs: (cron.data ?? []).map((c) => ({
        id: c.id,
        sessionId: c.sessionId,
        name: c.name,
        cron: c.cron,
        nextRun: c.nextRun,
        lastRun: c.lastRunAt,
        lastStatus: null,
      })),
      formations,
      artifacts: (artifacts.data ?? []).map((a) => ({
        kind: a.kind,
        name: a.name,
        ref: a.ref,
        origin: a.origin,
        modifiedAt: a.modifiedAt,
      })),
      memory: memory.entries.map((m) => ({
        id: m.id,
        key: m.key,
        namespace: m.namespace,
        category: m.category,
        content: m.content,
        timestamp: m.timestamp,
      })),
      skills: skills.skills.map((s) => ({ name: s.name, description: s.description, enabled: s.enabled })),
      services: SERVICES.map((s) => ({ id: s.id, label: s.label, route: s.route })),
    }),
    [sessions, currentSessionId, allRuns, cron.data, formations, memory.entries, skills.skills, artifacts.data]
  )
}
