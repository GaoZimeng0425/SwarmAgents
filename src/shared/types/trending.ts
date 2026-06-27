// Shared types for the GitHub trending feature. Mirrors the params and result
// shape of OSSInsight's `trending-repos` public query.

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
