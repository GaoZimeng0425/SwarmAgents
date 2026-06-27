// @vitest-environment jsdom
import type { TrendingRepo } from '@shared/types/trending'
import { describe, expect, it } from 'vitest'

import { buildResearchPrompt } from './use-research-repo'

const repo: TrendingRepo = {
  repoName: 'oven-sh/bun',
  description: 'Incredibly fast JavaScript runtime',
  language: 'Zig',
  stars: 1234,
  forks: 56,
  pullRequests: 7,
  totalScore: 88,
  contributorLogins: 'a,b',
}

describe('buildResearchPrompt', () => {
  it('includes the owner/repo, GitHub URL and metrics for the period', () => {
    const prompt = buildResearchPrompt(repo, 'past_week')
    expect(prompt).toContain('oven-sh/bun')
    expect(prompt).toContain('https://github.com/oven-sh/bun')
    expect(prompt).toContain('过去一周')
    expect(prompt).toContain('1234')
    expect(prompt).toContain('56')
    expect(prompt).toContain('7')
  })
})
