import type { TrendingPeriod, TrendingRepo } from '@swarm/protocol'
import { TRENDING_PERIOD_LABELS } from '@swarm/protocol'
import { useNavigate } from '@tanstack/react-router'

import { useSubmitGoal } from './use-tasks'

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
// Delegates to useSubmitGoal so settings persistence is included automatically.
export function useResearchRepo(): (repo: TrendingRepo, period: TrendingPeriod) => Promise<void> {
  const navigate = useNavigate()
  const submitGoal = useSubmitGoal()
  return async (repo, period) => {
    const { sessionId } = await submitGoal.mutateAsync({
      goal: buildResearchPrompt(repo, period),
      options: { permissionMode: 'ask', executionMode: 'goal', agentType: 'ceo' },
      forceNew: true,
    })
    void navigate({ to: '/session/$sessionId', params: { sessionId } })
  }
}
