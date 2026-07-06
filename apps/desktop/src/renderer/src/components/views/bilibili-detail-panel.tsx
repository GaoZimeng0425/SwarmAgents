// Persistent right-hand detail column for the Bilibili view. Owns the AI
// analysis lifecycle (process/transcribe/save mutations, analysis-cache query,
// transcription-progress subscription) and renders the summary/full-text reading
// area. Always mounted as a sibling of the video grid; shows an empty-state
// prompt when no video is selected.
import { useEffect, useState } from 'react'
import type { BiliSummary, BiliVideo } from '@swarm/protocol'
import { Button } from '@swarm/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { compact } from 'es-toolkit'
import { Sparkles, X } from 'lucide-react'

import { swarmApi } from '@/lib/api'
import { formatDuration } from './bilibili-view'
import { TranscribeProgress } from './transcribe-progress'

type DetailTab = 'analysis' | 'text'

function splitTextBlocks(text: string): string[] {
  return compact(text.split(/\n{2,}/).map((block) => block.trim()))
}

// Renders a structured BiliSummary: gist + non-empty labelled sections.
function SummaryView({ summary }: { summary: BiliSummary }): React.JSX.Element {
  const sections: { label: string; items: string[] }[] = [
    { label: '核心要点', items: summary.points },
    { label: '可复用经验', items: summary.experience },
    { label: '踩坑注意', items: summary.pitfalls },
    { label: '可执行步骤', items: summary.steps },
  ]
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-md border border-border bg-muted/30 p-4">
        <p className="mb-2 font-medium text-muted-foreground text-xs tracking-wide">一句话结论</p>
        <p className="text-[15px] text-foreground leading-7">{summary.gist}</p>
      </div>
      {sections
        .filter(({ items }) => items.length > 0)
        .map(({ label, items }) => (
          <section className="rounded-md border border-border p-4" key={label}>
            <p className="mb-3 font-medium text-foreground text-sm">{label}</p>
            <ul className="flex list-disc flex-col gap-2 pl-4 text-[13px] text-foreground/85 leading-6">
              {items.map((item, i) => (
                <li key={`${label}-${i}`}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
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
  onClose,
}: {
  video: BiliVideo | null
  onClose: () => void
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

  return (
    <aside className="flex w-[472px] shrink-0 flex-col border-border/60 border-l bg-background">
      {video ? (
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between gap-2 border-border/60 border-b p-4">
            <div className="min-w-0">
              <h2 className="truncate font-semibold text-foreground">{video.title}</h2>
              <p className="text-muted-foreground text-xs">
                {video.author} · {formatDuration(video.durationSec)}
              </p>
            </div>
            <Button aria-label="关闭详情" onClick={onClose} size="icon-sm" variant="ghost">
              <X className="size-4" />
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            {/* Left column: video metadata + actions. */}
            <aside className="flex shrink-0 flex-col gap-3 overflow-y-auto border-border p-4 pb-6 md:w-80 md:border-r">
              {video.cover ? (
                <img
                  alt=""
                  className="aspect-video w-full rounded-md border border-border object-cover"
                  referrerPolicy="no-referrer"
                  src={video.cover}
                />
              ) : null}
              {video.intro ? (
                <p className="whitespace-pre-wrap text-[13px] text-foreground/80 leading-6">{video.intro}</p>
              ) : (
                <p className="text-muted-foreground text-sm">无简介</p>
              )}
              <div className="text-muted-foreground text-xs">来源：{video.source}</div>
              <div className="flex flex-col gap-2 pt-1">
                <Button disabled={mutation.isPending} onClick={() => mutation.mutate(video.bvid)}>
                  {mutation.isPending ? '分析中…' : cached ? '重新分析' : 'AI 分析'}
                </Button>
                {/* Opens the video in the local Bilibili app (bilipc:), falling back to the browser. */}
                <Button onClick={() => void swarmApi.bilibiliOpen(video.bvid)} variant="outline">
                  观看
                </Button>
              </div>
              {/* No subtitle: offer local transcription instead of a dead-end error. */}
              {!summary && mutation.data && !mutation.data.ok && mutation.data.code === 'no_subtitle' ? (
                <div className="flex flex-col gap-2 border-border border-t pt-3">
                  <Button
                    className="w-fit"
                    disabled={transcribeMutation.isPending}
                    onClick={() => video && transcribeMutation.mutate(video.bvid)}
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
              {summary ? (
                <div className="mt-auto flex flex-col gap-1 border-border border-t pt-3">
                  <Button
                    className="w-fit"
                    disabled={saveMutation.isPending}
                    onClick={() => video && saveMutation.mutate({ video, summary })}
                    variant="outline"
                  >
                    {saveMutation.isPending ? '保存中…' : '保存到 Obsidian'}
                  </Button>
                  {saveMutation.data?.ok ? (
                    <span className="text-muted-foreground text-xs">已保存到 {saveMutation.data.path}</span>
                  ) : null}
                  {saveMutation.data && !saveMutation.data.ok ? (
                    <span className="text-destructive text-xs">{saveMutation.data.message}</span>
                  ) : null}
                </div>
              ) : null}
            </aside>
            {/* Right column: switchable reading area for the analysis and the raw text. */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {summary || fullText ? (
                <div className="flex items-center gap-1 border-border border-b p-2">
                  {summary ? (
                    <Button
                      data-active={detailTab === 'analysis' || undefined}
                      onClick={() => setDetailTab('analysis')}
                      size="sm"
                      variant={detailTab === 'analysis' ? 'secondary' : 'ghost'}
                    >
                      AI 解析
                    </Button>
                  ) : null}
                  {fullText ? (
                    <Button
                      data-active={detailTab === 'text' || undefined}
                      onClick={() => setDetailTab('text')}
                      size="sm"
                      variant={detailTab === 'text' ? 'secondary' : 'ghost'}
                    >
                      {textLabel}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {/* Only one view is mounted at a time so each gets the full reading height. */}
                {detailTab === 'analysis' && summary ? (
                  <SummaryView summary={summary} />
                ) : detailTab === 'text' && fullText ? (
                  <FullTextView label={textLabel} text={fullText.text} />
                ) : (
                  <p className="text-center text-muted-foreground text-sm">点击「AI 分析」生成结构化摘要。</p>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
          <Sparkles className="size-7 text-muted-foreground/40" />
          <p className="text-muted-foreground text-sm">选择一个视频查看 AI 解析</p>
        </div>
      )}
    </aside>
  )
}
