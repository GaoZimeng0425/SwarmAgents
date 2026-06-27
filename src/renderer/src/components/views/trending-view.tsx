import { useState } from 'react'
import {
  TRENDING_LANGUAGES,
  TRENDING_PERIOD_LABELS,
  TRENDING_PERIODS,
  type TrendingPeriod,
  type TrendingRepo,
} from '@shared/types/trending'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, GitFork, GitPullRequest, Star } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { useResearchRepo } from '@/hooks/use-research-repo'
import { swarmApi } from '@/lib/api'

export function TrendingView(): React.JSX.Element {
  const [period, setPeriod] = useState<TrendingPeriod>('past_24_hours')
  const [language, setLanguage] = useState<string>('All')
  const research = useResearchRepo()

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['trending', period, language],
    queryFn: () => swarmApi.getTrendingRepos(period, language),
  })

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <h1 className="mr-auto font-semibold text-foreground/90 text-lg">GitHub 趋势</h1>
        <NativeSelect onChange={(e) => setPeriod(e.target.value as TrendingPeriod)} value={period}>
          {TRENDING_PERIODS.map((p) => (
            <NativeSelectOption key={p} value={p}>
              {TRENDING_PERIOD_LABELS[p]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect onChange={(e) => setLanguage(e.target.value)} value={language}>
          {TRENDING_LANGUAGES.map((l) => (
            <NativeSelectOption key={l} value={l}>
              {l}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      {isError ? (
        <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
          <p>加载趋势失败</p>
          <Button onClick={() => void refetch()} variant="outline">
            重试
          </Button>
        </div>
      ) : isPending ? (
        <div className="py-12 text-center text-muted-foreground">加载中…</div>
      ) : data.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">暂无趋势数据</div>
      ) : (
        <ol className="flex flex-col gap-2">
          {data.map((repo, i) => (
            <RepoRow index={i} key={repo.repoName} onResearch={() => void research(repo, period)} repo={repo} />
          ))}
        </ol>
      )}
    </div>
  )
}

function RepoRow(props: { repo: TrendingRepo; index: number; onResearch: () => void }): React.JSX.Element {
  const { repo, index, onResearch } = props
  return (
    <li className="flex items-start gap-3 rounded-md border border-sidebar-border p-3 transition-colors hover:bg-sidebar-accent">
      <span className="w-6 shrink-0 text-center font-mono text-muted-foreground text-sm">{index + 1}</span>
      <button className="min-w-0 flex-1 text-left" onClick={onResearch} type="button">
        <div className="truncate font-medium text-foreground">{repo.repoName}</div>
        {repo.description ? <div className="truncate text-muted-foreground text-sm">{repo.description}</div> : null}
        <div className="mt-1 flex flex-wrap items-center gap-3 text-muted-foreground text-xs">
          {repo.language ? <span>{repo.language}</span> : null}
          <span className="inline-flex items-center gap-1">
            <Star className="size-3" /> {repo.stars}
          </span>
          <span className="inline-flex items-center gap-1">
            <GitFork className="size-3" /> {repo.forks}
          </span>
          <span className="inline-flex items-center gap-1">
            <GitPullRequest className="size-3" /> {repo.pullRequests}
          </span>
        </div>
      </button>
      <a
        aria-label="在浏览器打开"
        className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
        href={`https://github.com/${repo.repoName}`}
        rel="noreferrer"
        target="_blank"
      >
        <ExternalLink className="size-4" />
      </a>
    </li>
  )
}
