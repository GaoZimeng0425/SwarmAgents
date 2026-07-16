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
import { useRunningSessions } from './use-session-view'
import { useSkills } from './use-skills'

// The mixed 「快捷入口」 group navigates to the four service routes. Hardcoded
// here (not in the store) because these are fixed app sections, not user data.
const SERVICES = [
  { id: 'bilibili', label: 'Bilibili 收藏', route: '/bilibili' },
  { id: 'gmail', label: 'Gmail', route: '/gmail' },
  { id: 'scheduled', label: '定时任务', route: '/scheduled' },
  { id: 'trending', label: '热点', route: '/trending' },
] as const

/**
 * Gather every data source the palette needs into the BuildInputs shape.
 * `open` gates the heavier 快捷入口 count queries (Bilibili scrape / Gmail inbox)
 * so they only run while the palette is on screen — they share query keys with
 * the Bilibili/Gmail views, so an already-visited view makes them free.
 */
export function usePaletteData(open = false): BuildInputs {
  const sessions = useSessionsStore((s) => s.sessions)
  const currentSessionId = useSessionsStore((s) => s.selectedSessionId)
  const runningSessions = useRunningSessions()
  const cron = useAllCronJobs()
  const formations = useTeamOptions()
  const memory = useMemory()
  const skills = useSkills()
  const artifacts = useQuery({
    queryKey: ['palette', 'artifacts'],
    queryFn: () => swarmApi.listArtifacts({ limit: 50 }),
    staleTime: 60_000,
  })

  // --- 快捷入口 live counts (best-effort; errors just omit the count) ----------
  const biliList = useQuery({
    queryKey: ['bilibili', 'list'],
    queryFn: () => swarmApi.getBilibiliList(),
    enabled: open,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const biliAnalyzed = useQuery({
    queryKey: ['bilibili', 'analyzedBvids'],
    queryFn: () => swarmApi.bilibiliAnalyzedBvids(),
    enabled: open,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const gmailInbox = useQuery({
    queryKey: ['gmail', 'inboxCount'],
    queryFn: () => window.swarm.gmail.listInboxPage(0),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  })

  const serviceDetail = useMemo<Record<string, string>>(() => {
    const biliTotal =
      (biliList.data?.folders ?? []).reduce((n, f) => n + f.videos.length, 0) + (biliList.data?.watchLater.length ?? 0)
    const analyzed = biliAnalyzed.data?.length ?? 0
    const gmailTotal = gmailInbox.data?.total
    return {
      bilibili: biliTotal > 0 ? `${biliTotal} 个视频 · AI 已解析 ${analyzed}` : '视频收藏与解析',
      gmail: gmailTotal != null ? `收件箱 ${gmailTotal} 封` : '邮件收件箱',
      scheduled: `${cron.data?.length ?? 0} 个计划任务`,
      trending: 'GitHub 热门仓库',
    }
  }, [biliList.data, biliAnalyzed.data, gmailInbox.data, cron.data])

  return useMemo<BuildInputs>(
    () => ({
      sessions: sessions
        .filter((s) => !s.isSystem)
        .map((s) => ({ id: s.id, title: s.title, lastActiveAt: s.lastActiveAt, agentType: s.agentType })),
      currentSessionId,
      // 继续未完成 surfaces sessions with a live run (from useRunningSessions,
      // fed by agent_start/agent_end). Clicking navigates to the session to
      // continue it. Per-run plan/summary is deferred on the entry rails.
      runningMessages: sessions
        .filter((s) => !s.isSystem && runningSessions.has(s.id))
        .map((s) => ({
          id: s.id,
          sessionId: s.id,
          prompt: s.title ?? 'Untitled chat',
          status: 'running',
          summary: null,
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
      services: SERVICES.map((s) => ({ id: s.id, label: s.label, route: s.route, detail: serviceDetail[s.id] })),
    }),
    [
      sessions,
      currentSessionId,
      runningSessions,
      cron.data,
      formations,
      memory.entries,
      skills.skills,
      artifacts.data,
      serviceDetail,
    ]
  )
}
