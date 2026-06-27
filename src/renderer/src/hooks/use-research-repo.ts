import type { TrendingPeriod, TrendingRepo } from '@shared/types/trending'
import { TRENDING_PERIOD_LABELS } from '@shared/types/trending'
import { useNavigate } from '@tanstack/react-router'

import { swarmApi } from '@/lib/api'
import { useSessionsStore } from '@/stores/sessions'

// Build the Chinese research goal handed to the agent when a trending repo is clicked.
export function buildResearchPrompt(repo: TrendingRepo, period: TrendingPeriod): string {
  const label = TRENDING_PERIOD_LABELS[period]
  return [
    `调研 GitHub 仓库 ${repo.repoName}（https://github.com/${repo.repoName}）：`,
    `它解决什么问题、核心技术栈、近期活跃度（${label}内新增 ${repo.stars}⭐ / ${repo.forks} forks / ${repo.pullRequests} PR），`,
    '以及值得关注的点。',
  ].join('')
}

// Returns a callback that always creates a FRESH session, submits a research
// goal about the repo, and navigates to the new session.
export function useResearchRepo(): (repo: TrendingRepo, period: TrendingPeriod) => Promise<void> {
  const navigate = useNavigate()
  return async (repo, period) => {
    const { sessionId } = await swarmApi.createSession()
    useSessionsStore.getState().select(sessionId)
    await swarmApi.submitGoal(sessionId, buildResearchPrompt(repo, period), undefined, {
      permissionMode: 'ask',
      executionMode: 'goal',
      agentType: 'ceo',
    })
    void navigate({ to: '/session/$sessionId', params: { sessionId } })
  }
}
