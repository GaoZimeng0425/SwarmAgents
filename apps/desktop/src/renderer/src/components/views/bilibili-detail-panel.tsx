// Persistent right-hand detail column for the Bilibili view. Owns the AI
// analysis lifecycle (process/transcribe/save mutations, analysis-cache query,
// transcription-progress subscription) and renders the summary/full-text reading
// area. Always mounted as a sibling of the video grid; shows an empty-state
// prompt when no video is selected.
import { useEffect, useState } from 'react'
import type { BiliSummary, BiliVideo, UIEvent } from '@swarm/protocol'
import { Button } from '@swarm/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { compact } from 'es-toolkit'
import {
  Lightbulb,
  ListOrdered,
  Loader2,
  PanelRightClose,
  Sparkles,
  SquareCheckBig,
  TriangleAlert,
  Upload,
} from 'lucide-react'
import { Streamdown } from 'streamdown'

import { ScrollArea } from '@/components/ui/scroll-area'
import { swarmApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { BilibiliVideoMenu } from './bilibili-video-menu'
import { formatDuration, type VideoListContext } from './bilibili-view'
import { TranscribeProgress } from './transcribe-progress'

type DetailTab = 'analysis' | 'text'

function splitTextBlocks(text: string): string[] {
  return compact(text.split(/\n{2,}/).map((block) => block.trim()))
}

function sourceLabel(source?: string): string {
  return source === 'subtitle' ? '字幕' : source === 'transcript' ? '本地转写' : ''
}

// The three bullet-list sections, each with a color-coded icon badge + dots
// (Hi-fi: 核心要点 blue / 可复用经验 green / 踩坑注意 amber). Steps render
// separately as numbered circles below.
const BULLET_SECTIONS = [
  {
    key: 'points' as const,
    label: '核心要点',
    Icon: SquareCheckBig,
    iconWrap: 'bg-blue-500/12 text-blue-600 dark:text-blue-400',
    dot: 'bg-blue-500',
  },
  {
    key: 'experience' as const,
    label: '可复用经验',
    Icon: Lightbulb,
    iconWrap: 'bg-emerald-500/14 text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
  },
  {
    key: 'pitfalls' as const,
    label: '踩坑注意',
    Icon: TriangleAlert,
    iconWrap: 'bg-amber-500/16 text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500',
  },
]

// Renders a structured BiliSummary: an "AI 结构化摘要" divider, the gist as a
// tinted hero card, the color-coded bullet sections, and numbered steps.
function SummaryView({ summary, source }: { summary: BiliSummary; source?: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <span className="flex items-center gap-1.5 font-semibold text-violet-600 dark:text-violet-300">
          <Sparkles className="size-3" /> AI 结构化摘要
        </span>
        <span className="h-px flex-1 bg-border" />
        {source ? <span>来源:{sourceLabel(source)}</span> : null}
      </div>

      <div className="rounded-xl border border-violet-500/15 bg-linear-to-br from-violet-500/10 to-primary/5 p-3.5">
        <p className="mb-1.5 font-semibold text-[10.5px] text-violet-600/90 uppercase tracking-wide dark:text-violet-300/80">
          一句话结论
        </p>
        <p className="text-[13.5px] text-foreground/90 leading-relaxed">{summary.gist}</p>
      </div>

      {BULLET_SECTIONS.filter((s) => summary[s.key].length > 0).map((s) => (
        <div className="rounded-xl border border-border bg-secondary p-3.5" key={s.key}>
          <div className="mb-2.5 flex items-center gap-2">
            <span className={cn('flex size-5 items-center justify-center rounded-md', s.iconWrap)}>
              <s.Icon className="size-3" />
            </span>
            <span className="font-semibold text-[13px] text-foreground">{s.label}</span>
          </div>
          <div className="flex flex-col gap-2">
            {summary[s.key].map((item, i) => (
              <div className="flex gap-2 text-[12.5px] text-foreground/85 leading-relaxed" key={`${s.key}-${i}`}>
                <span className={cn('mt-[7px] size-[5px] shrink-0 rounded-full', s.dot)} />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      {summary.steps.length > 0 ? (
        <div className="rounded-xl border border-border bg-secondary p-3.5">
          <div className="mb-2.5 flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded-md bg-fuchsia-500/14 text-fuchsia-600 dark:text-fuchsia-400">
              <ListOrdered className="size-3" />
            </span>
            <span className="font-semibold text-[13px] text-foreground">可执行步骤</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {summary.steps.map((step, i) => (
              <div className="flex gap-2.5 text-[12.5px] text-foreground/85 leading-relaxed" key={`step-${i}`}>
                <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-fuchsia-500/12 font-bold text-[10.5px] text-fuchsia-600 dark:text-fuchsia-300">
                  {i + 1}
                </span>
                <span className="pt-px">{step}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

// Content-area placeholder while an AI analysis is in flight: mirrors the
// SummaryView layout (hero card + bullet blocks) with pulsing skeletons so the
// panel reads as "working" instead of showing the empty-state prompt.
function AnalyzingPlaceholder(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-1.5 font-semibold text-[11.5px] text-violet-600 dark:text-violet-300">
        <Loader2 className="size-3 animate-spin" /> AI 分析中…
      </div>
      <div className="h-16 animate-pulse rounded-xl bg-muted" />
      <div className="h-24 animate-pulse rounded-xl bg-muted" />
      <div className="h-24 animate-pulse rounded-xl bg-muted" />
    </div>
  )
}

function FullTextView({ label, text }: { label: string; text: string }): React.JSX.Element {
  const blocks = splitTextBlocks(text)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4 flex items-center justify-between">
        <p className="font-medium text-foreground text-sm">{label}</p>
        <span className="text-muted-foreground text-xs">{text.length.toLocaleString()} 字符</span>
      </div>
      <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-6 text-[15px] text-foreground/85 leading-7">
        {blocks.length > 0 ? (
          blocks.map((block, i) => (
            <p className="whitespace-pre-wrap" key={i}>
              {block}
            </p>
          ))
        ) : (
          <p className="whitespace-pre-wrap">{text}</p>
        )}
      </div>
    </div>
  )
}

export function BilibiliDetailPanel({
  video,
  context,
  pinned,
  onClose,
  onAnalyzingChange,
}: {
  video: BiliVideo | null
  context: VideoListContext
  pinned: boolean
  onClose: () => void
  /** Report the bvid currently being analyzed/transcribed (null when idle) so
   *  the grid can badge that card. */
  onAnalyzingChange?: (bvid: string | null) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const invalidateAnalysis = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['bilibili', 'analyzedBvids'] })
    if (video) void queryClient.invalidateQueries({ queryKey: ['bilibili', 'analysis', video.bvid] })
  }
  const mutation = useMutation({
    mutationFn: (bvid: string) => swarmApi.bilibiliProcess(bvid),
    onSuccess: invalidateAnalysis,
  })
  const transcribeMutation = useMutation({
    mutationFn: (bvid: string) => swarmApi.bilibiliTranscribe(bvid),
    onSuccess: invalidateAnalysis,
  })
  const saveMutation = useMutation({
    mutationFn: (args: { video: BiliVideo; summary: BiliSummary }) => swarmApi.bilibiliSave(args.video, args.summary),
  })
  const [stage, setStage] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('analysis')
  // Streamed analysis prose while the bilibili-analyst agent runs. Cleared on
  // completion (SummaryView takes over) or on video switch.
  const [streamText, setStreamText] = useState('')
  // Surfaces errors from the action menu (delete/pin). Cleared on video switch.
  const [menuError, setMenuError] = useState<string | null>(null)

  // Cached analysis for this video, if it has been analyzed before.
  const analysisQuery = useQuery({
    queryKey: ['bilibili', 'analysis', video?.bvid],
    queryFn: () => (video ? swarmApi.bilibiliGetAnalysis(video.bvid) : Promise.resolve(null)),
    enabled: video !== null,
  })

  // Reset mutations, stage, and the text toggle when the user switches video cards.
  useEffect(() => {
    mutation.reset()
    transcribeMutation.reset()
    saveMutation.reset()
    setStage(null)
    setDetailTab('analysis')
    setStreamText('')
    setMenuError(null)
    // We intentionally omit the mutation objects from deps — we only want to reset on bvid change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.bvid])

  // Subscribe to transcription progress only while this panel is mounted; show the
  // current stage on the in-flight button.
  useEffect(() => {
    const off = swarmApi.bilibiliOnTranscribeProgress((p) => {
      if (p.bvid === video?.bvid) setStage(p.stage)
    })
    return off
  }, [video?.bvid])

  // Subscribe to the streamed analysis from the bilibili-analyst agent. Deltas
  // accumulate into streamText (shown live via Streamdown); completion refreshes
  // the cached analysis so SummaryView takes over.
  useEffect(() => {
    if (!video?.bvid) return
    return window.swarm.subscribeEvents((e: UIEvent) => {
      if (e.kind === 'bilibili.analysisDelta' && e.bvid === video.bvid) {
        setStreamText((prev) => prev + e.text)
      } else if (e.kind === 'bilibili.analysisComplete' && e.bvid === video.bvid) {
        setStreamText('')
        invalidateAnalysis()
      } else if (e.kind === 'bilibili.analysisError' && e.bvid === video.bvid) {
        setStreamText('')
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.bvid])

  // Summary/full-text can come from a fresh subtitle run, a fresh transcription, or
  // the cached analysis loaded on open.
  const cached = analysisQuery.data ?? null
  const summary = mutation.data?.ok
    ? mutation.data.summary
    : transcribeMutation.data?.ok
      ? transcribeMutation.data.summary
      : (cached?.summary ?? null)
  const fullText = mutation.data?.ok
    ? { text: mutation.data.text, source: mutation.data.source }
    : transcribeMutation.data?.ok
      ? { text: transcribeMutation.data.text, source: transcribeMutation.data.source }
      : cached
        ? { text: cached.text, source: cached.source }
        : null

  useEffect(() => {
    if (!summary && fullText) setDetailTab('text')
  }, [fullText, summary])

  const textLabel = fullText?.source === 'subtitle' ? '字幕原文' : '转写全文'

  // Surface the in-flight bvid to the grid so it can show a loading badge on the
  // matching card; clear it when idle or when the panel unmounts.
  const analyzing = mutation.isPending || transcribeMutation.isPending
  useEffect(() => {
    onAnalyzingChange?.(analyzing && video ? video.bvid : null)
    return () => onAnalyzingChange?.(null)
  }, [analyzing, video?.bvid, onAnalyzingChange])

  return (
    <aside className="flex w-[472px] shrink-0 flex-col border-border/60 border-l bg-background/40">
      {video ? (
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-4 p-5">
            {/* Header: cover thumb + title/author + menu/close. */}
            <div className="flex gap-3">
              {video.cover ? (
                <img
                  alt=""
                  className="h-[63px] w-28 shrink-0 rounded-lg border border-border object-cover"
                  referrerPolicy="no-referrer"
                  src={video.cover}
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <h2 className="line-clamp-2 font-semibold text-[14.5px] text-foreground leading-snug">{video.title}</h2>
                <p className="mt-1 text-muted-foreground text-xs">
                  {video.author} · {formatDuration(video.durationSec)}
                </p>
              </div>
              <div className="flex shrink-0 items-start">
                <Button aria-label="收起详情" onClick={onClose} size="icon-sm" title="收起" variant="ghost">
                  <PanelRightClose className="size-4" />
                </Button>
              </div>
            </div>
            {menuError ? <p className="text-destructive text-xs">{menuError}</p> : null}

            {/* Action row: analyze / watch / save / more-menu (rightmost). */}
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={mutation.isPending}
                onClick={() => {
                  setStreamText('')
                  mutation.mutate(video.bvid)
                }}
              >
                {mutation.isPending ? '分析中…' : cached ? '重新分析' : 'AI 分析'}
              </Button>
              <Button onClick={() => void swarmApi.bilibiliOpen(video.bvid)} variant="outline">
                观看
              </Button>
              {summary ? (
                <Button
                  aria-label="保存到 Obsidian"
                  disabled={saveMutation.isPending}
                  onClick={() => video && saveMutation.mutate({ video, summary })}
                  size="icon"
                  title="保存到 Obsidian"
                  variant="outline"
                >
                  <Upload className="size-4" />
                </Button>
              ) : null}
              <BilibiliVideoMenu
                context={context}
                onChanged={onClose}
                onError={setMenuError}
                pinned={pinned}
                trigger="icon"
                video={video}
              />
            </div>
            {saveMutation.data?.ok ? (
              <span className="text-muted-foreground text-xs">已保存到 {saveMutation.data.path}</span>
            ) : null}
            {saveMutation.data && !saveMutation.data.ok ? (
              <span className="text-destructive text-xs">{saveMutation.data.message}</span>
            ) : null}

            {/* No subtitle: offer local transcription instead of a dead-end error. */}
            {!summary && mutation.data && !mutation.data.ok && mutation.data.code === 'no_subtitle' ? (
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-secondary p-3">
                <Button
                  className="w-fit"
                  disabled={transcribeMutation.isPending}
                  onClick={() => {
                    if (!video) return
                    setStreamText('')
                    transcribeMutation.mutate(video.bvid)
                  }}
                  variant="outline"
                >
                  {transcribeMutation.isPending ? '转写中…' : '本地转写'}
                </Button>
                {transcribeMutation.isPending ? <TranscribeProgress stage={stage} /> : null}
                <span className="text-muted-foreground text-xs">
                  该视频没有字幕，可下载音轨本地转写（需在设置中配置 ffmpeg 与模型）。
                </span>
                {transcribeMutation.data && !transcribeMutation.data.ok ? (
                  <span className="text-destructive text-xs">{transcribeMutation.data.message}</span>
                ) : null}
              </div>
            ) : null}
            {!summary && mutation.data && !mutation.data.ok && mutation.data.code !== 'no_subtitle' ? (
              <p className="text-destructive text-sm">{mutation.data.message}</p>
            ) : null}

            {/* Reading-area toggle, shown only when both an analysis and raw text exist. */}
            {summary && fullText ? (
              <div className="flex items-center gap-1 rounded-lg bg-muted/40 p-0.5">
                <button
                  className={cn(
                    'flex-1 rounded-md px-2 py-1 font-medium text-xs transition-colors',
                    detailTab === 'analysis' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
                  )}
                  onClick={() => setDetailTab('analysis')}
                  type="button"
                >
                  AI 解析
                </button>
                <button
                  className={cn(
                    'flex-1 rounded-md px-2 py-1 font-medium text-xs transition-colors',
                    detailTab === 'text' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
                  )}
                  onClick={() => setDetailTab('text')}
                  type="button"
                >
                  {textLabel}
                </button>
              </div>
            ) : null}

            {/* Content: structured analysis or raw text. */}
            {detailTab === 'analysis' && summary ? (
              <SummaryView source={fullText?.source} summary={summary} />
            ) : detailTab === 'text' && fullText ? (
              <FullTextView label={textLabel} text={fullText.text} />
            ) : streamText ? (
              <Streamdown>{streamText}</Streamdown>
            ) : mutation.isPending || transcribeMutation.isPending ? (
              <AnalyzingPlaceholder />
            ) : (
              <p className="py-8 text-center text-muted-foreground text-sm">点击「AI 分析」生成结构化摘要。</p>
            )}
          </div>
        </ScrollArea>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
          <Sparkles className="size-7 text-muted-foreground/40" />
          <p className="text-muted-foreground text-sm">选择一个视频查看 AI 解析</p>
        </div>
      )}
    </aside>
  )
}
