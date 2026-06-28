import { useState } from 'react'
import {
  TRENDING_LANGUAGES,
  TRENDING_PERIOD_LABELS,
  TRENDING_PERIODS,
  type TrendingPeriod,
  type TrendingRepo,
} from '@shared/types/trending'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, GitFork, GitPullRequest, Loader2, Sparkles, Star } from 'lucide-react'

import { Button, buttonVariants } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { useResearchRepo } from '@/hooks/use-research-repo'
import { swarmApi } from '@/lib/api'
import { cn } from '@/lib/utils'

// Short labels for the segmented control; full labels are used as tooltips.
// Stored as [period, label] pairs so the snake_case ids never appear as literal
// object member keys (which would trip the naming-convention lint rule).
const PERIOD_SHORT_LABELS: Map<TrendingPeriod, string> = new Map([
  ['past_24_hours', '24 小时'],
  ['past_week', '一周'],
  ['past_month', '一月'],
  ['past_3_months', '三月'],
])

// GitHub linguist colors so each language reads as a familiar chip.
const LANGUAGE_COLORS: Record<string, string> = {
  Assembly: '#6E4C13',
  C: '#555555',
  'C#': '#178600',
  'C++': '#f34b7d',
  'Common Lisp': '#3fb68b',
  CSS: '#563d7c',
  CMake: '#DA3434',
  Clojure: '#db5855',
  Dart: '#00B4AB',
  'Emacs Lisp': '#c065db',
  Elixir: '#6e4a7e',
  Erlang: '#B83998',
  Fortran: '#4d41b1',
  Go: '#00ADD8',
  Groovy: '#4298b8',
  HTML: '#e34c26',
  HCL: '#844FBA',
  Haskell: '#5e5086',
  Java: '#b07219',
  JavaScript: '#f1e05a',
  Julia: '#a270Ba',
  Kotlin: '#A97BFF',
  Lua: '#000080',
  MATLAB: '#e16737',
  OCaml: '#3be133',
  'Objective-C': '#438eff',
  PLpgSQL: '#336790',
  PHP: '#4F5D95',
  Perl: '#0298c3',
  PowerShell: '#012456',
  Python: '#3572A5',
  R: '#198CE7',
  Ruby: '#701516',
  Rust: '#dea584',
  Scala: '#c22d40',
  Shell: '#89e051',
  Solidity: '#AA6746',
  Swift: '#F05138',
  TSQL: '#e38c00',
  TypeScript: '#3178c6',
  Zig: '#ec915c',
}

function languageColor(language: string): string {
  return LANGUAGE_COLORS[language] ?? 'var(--muted-foreground)'
}

// Compact count formatting for star/fork/PR metrics (1200 -> 1.2k).
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function TrendingView(): React.JSX.Element {
  const [period, setPeriod] = useState<TrendingPeriod>('past_24_hours')
  const [language, setLanguage] = useState<string>('All')
  const [researching, setResearching] = useState<string | null>(null)
  const [researchError, setResearchError] = useState<string | null>(null)
  const research = useResearchRepo()

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['trending', period, language],
    queryFn: () => swarmApi.getTrendingRepos(period, language),
  })

  const handleResearch = async (repo: TrendingRepo): Promise<void> => {
    if (researching) return
    setResearchError(null)
    setResearching(repo.repoName)
    try {
      await research(repo, period)
    } catch {
      setResearchError(repo.repoName)
    } finally {
      setResearching(null)
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 p-5">
      <header className="flex flex-col gap-3">
        <div>
          <h1 className="font-semibold text-foreground text-xl">GitHub 趋势</h1>
          <p className="mt-0.5 text-muted-foreground text-sm">基于 OSSInsight 数据，点击「调研」让 Agent 调研仓库</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex items-center gap-0.5 rounded-lg border border-input bg-muted/50 p-0.5">
            {TRENDING_PERIODS.map((p) => (
              <button
                aria-label={`趋势周期：${TRENDING_PERIOD_LABELS[p]}`}
                aria-pressed={period === p}
                className={cn(
                  'rounded-md px-3 py-1 font-medium text-sm transition-colors',
                  period === p
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-card/60 hover:text-foreground'
                )}
                key={p}
                onClick={() => setPeriod(p)}
                title={TRENDING_PERIOD_LABELS[p]}
                type="button"
              >
                {PERIOD_SHORT_LABELS.get(p)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            {data && data.length > 0 ? (
              <span className="text-muted-foreground text-xs">共 {data.length} 个仓库</span>
            ) : null}
            <NativeSelect aria-label="语言" onChange={(e) => setLanguage(e.target.value)} value={language}>
              {TRENDING_LANGUAGES.map((l) => (
                <NativeSelectOption key={l} value={l}>
                  {l}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
      </header>

      {isError ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="font-medium text-foreground">加载趋势失败</p>
          <p className="max-w-sm text-muted-foreground text-sm">可能是网络问题，或 OSSInsight 暂时不可用。</p>
          <Button onClick={() => void refetch()} size="sm" variant="outline">
            重试
          </Button>
        </div>
      ) : isPending ? (
        <ol className="flex flex-col gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
            <SkeletonRow key={i} />
          ))}
        </ol>
      ) : data.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <p className="font-medium text-foreground">当前筛选下暂无趋势数据</p>
          <p className="text-muted-foreground text-sm">试试切换周期或语言。</p>
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {data.map((repo, i) => (
            <RepoRow
              index={i}
              isError={researchError === repo.repoName}
              isResearching={researching === repo.repoName}
              key={repo.repoName}
              onResearch={() => void handleResearch(repo)}
              repo={repo}
              researchDisabled={researching !== null}
            />
          ))}
        </ol>
      )}
    </div>
  )
}

function RepoRow(props: {
  repo: TrendingRepo
  index: number
  onResearch: () => void
  isResearching: boolean
  isError: boolean
  researchDisabled: boolean
}): React.JSX.Element {
  const { repo, index, onResearch, isResearching, isError, researchDisabled } = props
  const slashIndex = repo.repoName.indexOf('/')
  const owner = slashIndex >= 0 ? repo.repoName.slice(0, slashIndex) : repo.repoName
  const repoPart = slashIndex >= 0 ? repo.repoName.slice(slashIndex + 1) : ''
  const topThree = index < 3

  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-card/60 p-3.5 transition-colors hover:bg-card/80">
      <span
        className={cn(
          'w-6 shrink-0 pt-0.5 text-center font-mono text-sm tabular-nums',
          topThree ? 'font-semibold text-primary' : 'text-muted-foreground'
        )}
      >
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-0.5 truncate text-sm">
          <span className="text-muted-foreground">{owner}</span>
          {repoPart ? (
            <>
              <span className="text-muted-foreground">/</span>
              <span className="font-semibold text-foreground">{repoPart}</span>
            </>
          ) : null}
        </div>
        {repo.description ? (
          <p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">{repo.description}</p>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
          {repo.language ? (
            <span className="inline-flex items-center gap-1">
              <span className="size-2.5 rounded-full" style={{ backgroundColor: languageColor(repo.language) }} />
              {repo.language}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <Star className="size-3" /> {formatCount(repo.stars)}
          </span>
          <span className="inline-flex items-center gap-1">
            <GitFork className="size-3" /> {formatCount(repo.forks)}
          </span>
          <span className="inline-flex items-center gap-1">
            <GitPullRequest className="size-3" /> {formatCount(repo.pullRequests)}
          </span>
          <span className="inline-flex items-center gap-1 text-foreground/70">热度 {repo.totalScore.toFixed(1)}</span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <div className="flex items-center gap-1">
          <Button
            disabled={researchDisabled}
            onClick={onResearch}
            size="sm"
            variant={isResearching ? 'secondary' : 'default'}
          >
            {isResearching ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            {isResearching ? '调研中' : '调研'}
          </Button>
          <a
            aria-label="在 GitHub 打开"
            className={buttonVariants({ size: 'icon-sm', variant: 'ghost' })}
            href={`https://github.com/${repo.repoName}`}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink />
          </a>
        </div>
        {isError ? <p className="text-destructive text-xs">创建会话失败，请检查模型配置</p> : null}
      </div>
    </li>
  )
}

function SkeletonRow(): React.JSX.Element {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-card/40 p-3.5">
      <Skeleton className="size-5 shrink-0 rounded" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-48 rounded" />
        <Skeleton className="h-3 w-full max-w-md rounded" />
        <div className="flex gap-3">
          <Skeleton className="h-3 w-16 rounded" />
          <Skeleton className="h-3 w-12 rounded" />
          <Skeleton className="h-3 w-12 rounded" />
        </div>
      </div>
      <Skeleton className="h-7 w-16 shrink-0 rounded-md" />
    </li>
  )
}
