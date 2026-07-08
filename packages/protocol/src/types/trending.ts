// Shared types for the GitHub trending feature. Mirrors the params and result
// shape of OSSInsight's `trending-repos` public query.
import { z } from 'zod'

import { ProviderInjection } from './provider'

export const TRENDING_PERIODS = ['past_24_hours', 'past_week', 'past_month', 'past_3_months'] as const
export type TrendingPeriod = (typeof TRENDING_PERIODS)[number]

// Chinese UI labels for each period (user-facing copy, not a code comment).
// biome-ignore lint/style/useNamingConvention: Record keys must match TrendingPeriod enum
export const TRENDING_PERIOD_LABELS: Record<TrendingPeriod, string> = {
  past_24_hours: '过去 24 小时',
  past_week: '过去一周',
  past_month: '过去一月',
  past_3_months: '过去三月',
}

// Language filter options, taken verbatim from OSSInsight's trending-repos query.
// 'All' means no language filter.
export const TRENDING_LANGUAGES = [
  'All',
  'JavaScript',
  'Java',
  'Python',
  'PHP',
  'C++',
  'C#',
  'TypeScript',
  'Shell',
  'C',
  'Ruby',
  'Rust',
  'Go',
  'Kotlin',
  'HCL',
  'PowerShell',
  'CMake',
  'Groovy',
  'PLpgSQL',
  'TSQL',
  'Dart',
  'Swift',
  'HTML',
  'CSS',
  'Elixir',
  'Haskell',
  'Solidity',
  'Assembly',
  'R',
  'Scala',
  'Julia',
  'Lua',
  'Clojure',
  'Erlang',
  'Common Lisp',
  'Emacs Lisp',
  'OCaml',
  'MATLAB',
  'Objective-C',
  'Perl',
  'Fortran',
  'Zig',
] as const
export type TrendingLanguage = (typeof TRENDING_LANGUAGES)[number]

export type TrendingRepo = {
  repoName: string
  description: string
  language: string
  stars: number
  forks: number
  pullRequests: number
  totalScore: number
  contributorLogins: string
}

// Verdict tone drives the panel's accent color (green / violet / amber / gray).
// The agent picks the tone; the frontend maps it to colors so copy and styling
// stay decoupled.
export const RepoVerdictTone = z.enum(['recommend', 'adopt', 'caution', 'watch'])
export type RepoVerdictTone = z.infer<typeof RepoVerdictTone>

// Structured output of the repo-researcher agent — mirrors ArticleSummary but
// carries the trending-panel sections (为什么上榜 / 核心亮点 / 适合谁用 / 结论).
export const RepoResearch = z.object({
  gist: z.string(),
  why: z.string(),
  highlights: z.array(z.string()),
  forWhom: z.string(),
  verdict: z.string(),
  verdictTag: z.string(),
  verdictTone: RepoVerdictTone,
})
export type RepoResearch = z.infer<typeof RepoResearch>

// researchRepo: renderer→main→service (main injects provider). The repo is
// client-supplied (the trending list is fetched live, never persisted server-
// side), so the request carries the fields the researcher prompt needs.
export const ResearchRepoRequest = z.object({
  repo: z.object({
    repoName: z.string(),
    description: z.string(),
    language: z.string(),
    stars: z.number(),
    forks: z.number(),
    pullRequests: z.number(),
    contributorLogins: z.string(),
  }),
  period: z.enum(TRENDING_PERIODS),
  provider: ProviderInjection,
})
export type ResearchRepoRequest = z.infer<typeof ResearchRepoRequest>

export const ResearchRepoResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['no_provider', 'no_agent']),
    message: z.string(),
  }),
])
export type ResearchRepoResult = z.infer<typeof ResearchRepoResult>
