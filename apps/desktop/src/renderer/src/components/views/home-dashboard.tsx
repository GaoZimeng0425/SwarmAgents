// The 任务台 dashboard (Phase 2). Replaces HomeComposer on `/`. Composes the
// slim top bar, the hero composer (reusing <ChatInput> unchanged inside a new
// shell), and the three live sections — 进行中 card wall, 定时任务, 最近完成.
//
// All data comes from existing caches (useRuns, useAllCronJobs, useAllCronRuns)
// and the sessions store; the dashboard itself owns no new fetch. The single
// useNow tick drives elapsed wall time + cron countdowns at 30s granularity.

import { providerViewById } from '@swarm/protocol'
import { useNavigate } from '@tanstack/react-router'

import { ChatInput } from '@/components/chat-input'
import { DashboardTopbar } from '@/components/views/dashboard/dashboard-topbar'
import { RecentList } from '@/components/views/dashboard/recent-list'
import { RunningCards } from '@/components/views/dashboard/running-cards'
import { ScheduledList } from '@/components/views/dashboard/scheduled-list'
import { WeatherCard } from '@/components/views/dashboard/weather-card'
import { useTeamOptions } from '@/hooks/use-agents'
import { useAllCronJobs, useAllCronRuns } from '@/hooks/use-cron'
import { useNow } from '@/hooks/use-now'
import { useProviders } from '@/hooks/use-providers'
import { useRuns, useSubmitGoal } from '@/hooks/use-runs'
import { selectDashboardCron } from '@/lib/dashboard-cron'
import { selectDashboardRecent } from '@/lib/dashboard-recent'
import { selectDashboardRuns } from '@/lib/dashboard-runs'
import { useComposerDefaults } from '@/stores/composer-defaults'
import { useSessionsStore } from '@/stores/sessions'

export function HomeDashboard(): React.JSX.Element {
  const navigate = useNavigate()
  const submitGoal = useSubmitGoal()
  const { ready, state } = useProviders()
  const now = useNow(30_000)

  // Composer defaults (same pattern as the old HomeComposer — persisted controls
  // carried into the first turn, then the session owns its own copy).
  const cwd = useComposerDefaults((s) => s.cwd)
  const setCwd = useComposerDefaults((s) => s.setCwd)
  const permissionMode = useComposerDefaults((s) => s.permissionMode)
  const setPermissionMode = useComposerDefaults((s) => s.setPermissionMode)
  const executionMode = useComposerDefaults((s) => s.executionMode)
  const setExecutionMode = useComposerDefaults((s) => s.setExecutionMode)
  const agentType = useComposerDefaults((s) => s.agentType)
  const setAgentType = useComposerDefaults((s) => s.setAgentType)
  const teamOptions = useTeamOptions()

  // Dashboard data.
  const runs = useRuns()
  const sessions = useSessionsStore((s) => s.sessions)
  const cronJobs = useAllCronJobs().data ?? []
  const cronRuns = useAllCronRuns().data ?? []

  const { running, awaiting } = selectDashboardRuns(runs, sessions, teamOptions, now)
  const { rows: cronRows } = selectDashboardCron(cronJobs, cronRuns, now)
  const { rows: recentRows } = selectDashboardRecent(sessions)

  return (
    <div className="flex h-full flex-col">
      <DashboardTopbar runningCount={running.length} />

      <div className="mx-auto flex w-full max-w-[1088px] flex-1 flex-col gap-6 overflow-y-auto px-6 py-5">
        {/* Composer */}
        <section className="flex flex-col gap-4">
          <h2 className="font-semibold text-[26px] text-foreground tracking-tight">今天想让 swarm 做点什么?</h2>
          <ChatInput
            agentType={agentType}
            cwd={cwd}
            disabled={!ready}
            executionMode={executionMode}
            onAgentTypeChange={setAgentType}
            onCwdChange={setCwd}
            onExecutionModeChange={setExecutionMode}
            onPermissionModeChange={setPermissionMode}
            onSubmit={async (goal, attachments) => {
              if (!ready) return
              const { sessionId } = await submitGoal.mutateAsync({
                goal,
                attachments,
                options: { cwd, permissionMode, executionMode, agentType },
              })
              void navigate({ to: '/session/$sessionId', params: { sessionId } })
            }}
            permissionMode={permissionMode}
            placeholder="描述一个目标,或按 ⌘⏎ 从剪贴板开始…"
            supportsImages={!!providerViewById(state, state.active)?.supportsImages}
            teamOptions={teamOptions}
            variant="hero"
          />
        </section>

        {/* 天气 */}
        <WeatherCard />

        {/* 进行中 */}
        <RunningCards awaiting={awaiting} running={running} />

        {/* 定时任务 + 最近完成 */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ScheduledList rows={cronRows} />
          <RecentList now={now} rows={recentRows} />
        </div>
      </div>
    </div>
  )
}
