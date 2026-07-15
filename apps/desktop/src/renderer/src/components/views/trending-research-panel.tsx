// Persistent right-hand detail column for the trending view. Owns the Agent
// research lifecycle (researchRepo IPC + streaming trending.research*
// subscription) and renders the structured briefing (一句话结论 / 为什么上榜 /
// 核心亮点 / 适合谁用 / 结论) or the live-streaming markdown. Mirrors
// article-detail-panel.tsx. Always mounted as a sibling of the repo list.
import { useEffect, useMemo } from 'react'
import type { RepoResearch, RepoVerdictTone, TrendingPeriod, TrendingRepo } from '@swarm/protocol'
import { Button } from '@swarm/ui'
import { useQuery } from '@tanstack/react-query'
import {
  Check,
  ChevronRight,
  ExternalLink,
  Flame,
  GitFork,
  GitPullRequest,
  Loader2,
  Sparkles,
  Star,
  Users,
} from 'lucide-react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { useAnalysisStream } from '@/hooks/use-analysis-stream'
import { swarmApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { AnalysisContent } from './analysis-primitives'

// Verdict tone → accent classes (green / violet / amber / gray), matching the
// design's four verdict families. The agent picks the tone; the label text
// (verdictTag) rides alongside.
const VERDICT_TONE: Record<RepoVerdictTone, { chip: string; box: string }> = {
  recommend: {
    chip: 'bg-emerald-600 text-white',
    box: 'border-emerald-500/25 bg-emerald-500/10',
  },
  adopt: {
    chip: 'bg-violet-600 text-white',
    box: 'border-violet-500/25 bg-violet-500/10',
  },
  caution: {
    chip: 'bg-amber-500 text-white',
    box: 'border-amber-500/25 bg-amber-500/10',
  },
  watch: {
    chip: 'bg-muted-foreground text-background',
    box: 'border-border bg-muted/40',
  },
}

function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

// Renders a completed RepoResearch as the design's Agent 调研 card.
function ResearchView({ research }: { research: RepoResearch }): React.JSX.Element {
  const tone = VERDICT_TONE[research.verdictTone]
  return (
    <div className="overflow-hidden rounded-xl border border-violet-500/20 shadow-sm">
      <div className="flex items-center gap-2 border-violet-500/15 border-b bg-linear-to-br from-violet-500/10 to-primary/10 px-4 py-2.5">
        <span className="flex size-5 items-center justify-center rounded-md bg-linear-to-br from-violet-500 to-primary">
          <Sparkles className="size-3 text-white" />
        </span>
        <span className="font-semibold text-[13px] text-violet-700 dark:text-violet-300">Agent 调研</span>
        <span className="ml-auto text-[10.5px] text-violet-500/80">基于仓库信息 + 模型知识</span>
      </div>

      <div className="flex flex-col gap-3.5 bg-secondary p-4">
        <p className="font-medium text-[13.5px] text-foreground/90 leading-relaxed">{research.gist}</p>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <Flame className="size-3.5 text-amber-600" />
            <span className="font-semibold text-[11.5px] text-amber-600">为什么上榜</span>
          </div>
          <p className="text-[12.5px] text-foreground/75 leading-relaxed">{research.why}</p>
        </div>

        {research.highlights.length > 0 ? (
          <div className="rounded-lg border border-border/60 bg-background/50 p-3">
            <p className="mb-2 text-[10.5px] text-muted-foreground uppercase tracking-wide">核心亮点</p>
            <ul className="flex flex-col gap-2">
              {research.highlights.map((h) => (
                <li className="flex gap-2 text-[12.5px] text-foreground/85 leading-relaxed" key={h}>
                  <Check className="mt-0.5 size-3.5 shrink-0 text-violet-500" />
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <p className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground uppercase tracking-wide">
            <Users className="size-3" /> 适合谁用
          </p>
          <p className="text-[12.5px] text-foreground/75 leading-relaxed">{research.forWhom}</p>
        </div>

        <div className={cn('flex items-start gap-2.5 rounded-lg border p-3', tone.box)}>
          <span className={cn('shrink-0 rounded-md px-2 py-1 font-semibold text-[10.5px] leading-none', tone.chip)}>
            {research.verdictTag}
          </span>
          <span className="text-[12px] text-foreground/85 leading-relaxed">{research.verdict}</span>
        </div>
      </div>
    </div>
  )
}

export function TrendingResearchPanel({
  repo,
  period,
  onClose,
  onResearchingChange,
}: {
  repo: TrendingRepo
  period: TrendingPeriod
  onClose: () => void
  /** Report the repoName currently streaming research (null when idle) so the
   *  list row can badge it. */
  onResearchingChange?: (repoName: string | null) => void
}): React.JSX.Element {
  const slashIndex = repo.repoName.indexOf('/')
  const owner = slashIndex >= 0 ? repo.repoName.slice(0, slashIndex) : repo.repoName
  const name = slashIndex >= 0 ? repo.repoName.slice(slashIndex + 1) : ''

  // Cached research for this repo (re-viewable across selections/restarts).
  const cached = useQuery({
    queryKey: ['trending', 'research', repo.repoName],
    queryFn: () => swarmApi.getRepoResearch(repo.repoName),
  })

  const { state, analyze } = useAnalysisStream<RepoResearch>({
    id: repo.repoName,
    events: { delta: 'trending.researchDelta', complete: 'trending.researchComplete', error: 'trending.researchError' },
    idField: 'repoName',
    parseComplete: (e) => (e as { research: RepoResearch }).research,
    trigger: () => swarmApi.researchRepo(repo, period),
    cachedResult: cached.data?.research ?? null,
    invalidateOnComplete: [
      ['trending', 'research', repo.repoName],
      ['trending', 'researchedNames'],
    ],
  })

  // Surface the in-flight repo to the list so it can badge the matching row.
  const phase = state.phase
  useEffect(() => {
    onResearchingChange?.(phase === 'streaming' ? repo.repoName : null)
    return () => onResearchingChange?.(null)
  }, [phase, repo.repoName, onResearchingChange])

  const streamText = state.phase === 'streaming' || state.phase === 'done' ? state.streamText : ''
  const error = state.phase === 'error' ? state.error : null
  const liveResearch = state.phase === 'done' ? state.result : null
  const research = liveResearch ?? cached.data?.research ?? null
  // Markdown briefing for the done state: the freshly streamed summary wins, then
  // a cached research's persisted summary (so a re-view also shows the briefing).
  const summary = streamText || research?.summary || ''

  function handleResearch(): void {
    analyze()
  }

  const metrics = useMemo(
    () => [
      { icon: <Star className="size-3.5" />, value: compactCount(repo.stars) },
      { icon: <GitFork className="size-3.5" />, value: compactCount(repo.forks) },
      { icon: <GitPullRequest className="size-3.5" />, value: `${compactCount(repo.pullRequests)} PR` },
    ],
    [repo.stars, repo.forks, repo.pullRequests]
  )

  return (
    <aside className="flex w-[472px] shrink-0 flex-col border-border/60 border-l bg-background">
      <div className="flex items-start gap-2 border-border/60 border-b p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-0.5 text-[15px]">
            <span className="truncate text-muted-foreground">{owner}</span>
            {name ? (
              <>
                <span className="text-muted-foreground/60">/</span>
                <span className="truncate font-bold text-[16px] text-foreground">{name}</span>
              </>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 font-medium text-[12px] text-muted-foreground">
            {repo.language ? <span>{repo.language}</span> : null}
            {metrics.map((m) => (
              <span className="inline-flex items-center gap-1" key={m.value}>
                {m.icon} {m.value}
              </span>
            ))}
          </div>
          {error ? <p className="mt-1.5 text-destructive text-xs">{error}</p> : null}
        </div>
        <Button aria-label="收起详情" onClick={onClose} size="icon-sm" variant="ghost">
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <div className="flex gap-2 p-4 pb-2">
        <Button className="flex-1" disabled={phase === 'streaming'} onClick={() => void handleResearch()}>
          {phase === 'streaming' ? (
            <>
              <Loader2 className="animate-spin" /> 调研中…
            </>
          ) : (
            <>
              <Sparkles /> {research ? '重新调研' : '让 Agent 深入调研'}
            </>
          )}
        </Button>
        <Button onClick={() => window.open(`https://github.com/${repo.repoName}`, '_blank')} variant="outline">
          <ExternalLink /> GitHub
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1" edgeFade>
        <div className="p-4 pt-2">
          <AnalysisContent
            analyzingLabel="Agent 调研中…"
            doneMarkdown={summary || undefined}
            emptyPrompt="点击「让 Agent 深入调研」生成结构化简报"
            error={error}
            phase={phase}
            resultCard={research ? <ResearchView research={research} /> : undefined}
            streamText={streamText}
          />
        </div>
      </ScrollArea>
    </aside>
  )
}
