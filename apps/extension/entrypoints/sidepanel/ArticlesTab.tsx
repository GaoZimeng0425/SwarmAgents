import { type JSX, useCallback, useEffect, useState } from 'react'
import type { ArticleSummary, CollectedArticleWithAnalysis } from '@swarm/protocol'
import { Button } from '@swarm/ui'

type CollectStatus = { kind: 'pending' } | { kind: 'ok'; articleId?: string } | { kind: 'err'; error: string }
type ListResult = { ok: true; articles: CollectedArticleWithAnalysis[] } | { ok: false; error: string }
type AnalysisResult =
  | { ok: true; summary: ArticleSummary | null; analyzedAt: string | null }
  | { ok: false; error: string }

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function shortDate(iso: string): string {
  try {
    const d = new Date(iso)
    return `${d.getMonth() + 1}月${d.getDate()}日`
  } catch {
    return ''
  }
}

export function ArticlesTab({ connected }: { connected: boolean }): JSX.Element {
  const [collecting, setCollecting] = useState(false)
  const [collectStatus, setCollectStatus] = useState<CollectStatus | null>(null)

  const [wsHost, setWsHost] = useState('ws://127.0.0.1:47777')
  const [token, setToken] = useState('')
  const [savedHint, setSavedHint] = useState(false)

  const [articles, setArticles] = useState<CollectedArticleWithAnalysis[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<ArticleSummary | null>(null)
  const [, setAnalyzedAt] = useState<string | null>(null)

  useEffect(() => {
    browser.storage.local.get(['wsHost', 'token']).then((v) => {
      if (v.wsHost) setWsHost(v.wsHost as string)
      if (v.token) setToken(v.token as string)
    })
  }, [])

  const refreshList = useCallback((): void => {
    browser.runtime.sendMessage({ type: 'listArticles' }, (r: ListResult) => {
      if (r?.ok) {
        setArticles(r.articles)
        setListError(null)
      } else {
        setListError(r?.error ?? '加载失败')
      }
    })
  }, [])

  useEffect(() => {
    if (connected) refreshList()
  }, [connected, refreshList])

  useEffect(() => {
    const listener = (msg: { type?: string; articleId?: string; summary?: ArticleSummary }): void => {
      if (msg?.type === 'article.analysisComplete' && msg.articleId === selectedId && msg.summary) {
        setAnalysis(msg.summary)
        setAnalyzedAt(new Date().toISOString())
      }
    }
    browser.runtime.onMessage.addListener(listener)
    return () => browser.runtime.onMessage.removeListener(listener)
  }, [selectedId])

  useEffect(() => {
    if (!selectedId) {
      setAnalysis(null)
      setAnalyzedAt(null)
      return
    }
    browser.runtime.sendMessage({ type: 'getArticleAnalysis', articleId: selectedId }, (r: AnalysisResult) => {
      if (r?.ok) {
        setAnalysis(r.summary)
        setAnalyzedAt(r.analyzedAt)
      }
    })
  }, [selectedId])

  const collect = (): void => {
    setCollecting(true)
    setCollectStatus({ kind: 'pending' })
    browser.runtime.sendMessage(
      { type: 'collectCurrentPage' },
      (r: { ok: boolean; articleId?: string; error?: string }) => {
        if (r?.ok) {
          setCollectStatus({ kind: 'ok', articleId: r.articleId })
          refreshList()
        } else {
          setCollectStatus({ kind: 'err', error: r?.error ?? 'unknown error' })
        }
        setCollecting(false)
      }
    )
  }

  const saveConfig = (): void => {
    browser.storage.local.set({ wsHost, token }).then(() => {
      setSavedHint(true)
      setTimeout(() => setSavedHint(false), 2500)
    })
  }

  const selected = articles.find((a) => a.id === selectedId) ?? null

  return (
    <>
      {!connected ? (
        <section className="flex flex-col gap-2 rounded-md border border-border p-3">
          <label className="text-muted-foreground text-xs" htmlFor="token">
            Token(从桌面端 设置 → 远程连接 复制)
          </label>
          <input
            className="rounded border border-border bg-background px-2 py-1 font-mono text-xs"
            id="token"
            onChange={(e) => setToken(e.target.value)}
            placeholder="粘贴 token"
            type="password"
            value={token}
          />
          <details className="text-muted-foreground text-xs">
            <summary className="cursor-pointer select-none">高级(WS host)</summary>
            <input
              className="mt-2 w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
              onChange={(e) => setWsHost(e.target.value)}
              value={wsHost}
            />
          </details>
          <Button className="mt-1" disabled={token.trim().length === 0} onClick={saveConfig} size="sm">
            保存并重连
          </Button>
          {savedHint && <p className="text-emerald-600 text-xs">已保存,后台正在重连…</p>}
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <Button className="w-full" disabled={collecting} onClick={collect}>
              📄 收集当前页到文章库
            </Button>
            {collectStatus?.kind === 'pending' && <p className="text-muted-foreground text-xs">◷ 发送中…</p>}
            {collectStatus?.kind === 'ok' && <p className="text-emerald-600 text-xs">✓ 已收集</p>}
            {collectStatus?.kind === 'err' && <p className="text-destructive text-xs">✗ {collectStatus.error}</p>}
          </section>

          {selected ? (
            <section className="flex min-h-0 flex-1 flex-col gap-3">
              <button
                className="text-left text-muted-foreground text-xs underline"
                onClick={() => setSelectedId(null)}
                type="button"
              >
                ← 返回列表
              </button>
              <div className="flex flex-col gap-0.5">
                <h4 className="font-medium text-sm leading-snug">{selected.title}</h4>
                <p className="text-muted-foreground text-xs">
                  {selected.siteName ?? hostnameOf(selected.url)} · {shortDate(selected.collectedAt)}
                </p>
              </div>
              <div className="border-border border-t" />
              {analysis ? (
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                  <div className="rounded-md border border-border bg-muted/30 p-2.5">
                    <p className="mb-1 text-[10px] text-muted-foreground tracking-wide">一句话结论</p>
                    <p className="text-foreground text-xs leading-5">{analysis.gist}</p>
                  </div>
                  {analysis.points.length > 0 ? (
                    <div>
                      <p className="mb-1 text-[10px] text-muted-foreground tracking-wide">核心要点</p>
                      <ul className="flex list-disc flex-col gap-1 pl-4 text-xs leading-5">
                        {analysis.points.map((p, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: plain string list, no stable id
                          <li key={i}>{p}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {analysis.takeaways.length > 0 ? (
                    <div>
                      <p className="mb-1 text-[10px] text-muted-foreground tracking-wide">可带走洞察</p>
                      <ul className="flex list-disc flex-col gap-1 pl-4 text-xs leading-5">
                        {analysis.takeaways.map((p, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: plain string list, no stable id
                          <li key={i}>{p}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">这篇文章还没有分析。去 desktop 选中它点「AI 分析」。</p>
              )}
              <a
                className="text-muted-foreground text-xs underline"
                href={selected.url}
                rel="noreferrer"
                target="_blank"
              >
                打开原文 ↗
              </a>
            </section>
          ) : (
            <section className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground text-xs">
                  已收集 <span className="tabular-nums">{articles.length}</span> 篇
                </p>
                <button className="text-muted-foreground text-xs underline" onClick={refreshList} type="button">
                  刷新
                </button>
              </div>
              {listError ? <p className="text-destructive text-xs">{listError}</p> : null}
              <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                {articles.length === 0 && !listError ? (
                  <p className="text-muted-foreground text-xs">还没有收集的文章。打开一篇文章,点上方按钮收集。</p>
                ) : null}
                {articles.map((a) => (
                  <button
                    className="flex flex-col gap-0.5 rounded border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-sidebar-accent"
                    key={a.id}
                    onClick={() => setSelectedId(a.id)}
                    type="button"
                  >
                    <div className="flex items-center gap-1.5">
                      {a.summary ? (
                        <span className="rounded bg-primary px-1 font-medium text-[9px] text-primary-foreground">
                          AI
                        </span>
                      ) : null}
                      <span className="line-clamp-1 font-medium text-xs">{a.title}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {a.siteName ?? hostnameOf(a.url)} · {shortDate(a.collectedAt)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </>
  )
}
