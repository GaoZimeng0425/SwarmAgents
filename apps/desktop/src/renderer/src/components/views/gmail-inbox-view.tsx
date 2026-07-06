// src/renderer/src/components/views/gmail-inbox-view.tsx
//
// Human-facing Gmail inbox (the daemon syncs into the cache; this view reads
// it). Master/detail: left = thread list (listRecent) or search results, right
// = the selected thread's messages (getThread). The daemon broadcasts
// gmail:stateChanged after every poll, so the list refetches live.
import { useEffect, useMemo, useState } from 'react'
import type { GmailAnalysis, GmailMessage, UIEvent } from '@swarm/protocol'
import { Button, Input, Skeleton } from '@swarm/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Inbox, Loader2, MailOpen, RefreshCw, Search, Sparkles } from 'lucide-react'
import { Streamdown } from 'streamdown'

import { EmailHtml } from '@/components/email-html'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useThreadAnalysis } from '@/hooks/use-thread-analysis'
import { swarmApi } from '@/lib/api'
import { classifyAll, classifyThread, type GmailGroupKey } from '@/lib/gmail/classify-thread'
import { cn } from '@/lib/utils'
import { GmailAssistantCard } from './gmail-assistant-card'
import { GmailGroupBar } from './gmail-group-bar'

const PAGE_LIMIT = 50

// Gmail From headers are usually "Name <email@x>"; show the name part, fall
// back to the bare address.
function fromDisplay(fromAddr: string): string {
  const lt = fromAddr.indexOf('<')
  if (lt > 0) return fromAddr.slice(0, lt).replace(/"/g, '').trim()
  return fromAddr
}

function formatListDate(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString()
}

export function GmailInboxView(): React.JSX.Element {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('') // committed search; '' = listRecent
  const [activeGroup, setActiveGroup] = useState<GmailGroupKey>('all')

  const status = useQuery({ queryKey: ['gmail', 'status'], queryFn: () => window.swarm.gmail.getStatus() })
  const linked = status.data?.loggedIn === true

  // Live refresh: every background poll / manual sync broadcasts stateChanged.
  useEffect(
    () =>
      window.swarm.gmail.onStateChanged(() => {
        void qc.invalidateQueries({ queryKey: ['gmail', 'list'] })
        void qc.invalidateQueries({ queryKey: ['gmail', 'status'] })
      }),
    [qc]
  )

  const list = useQuery({
    queryKey: ['gmail', 'list', query],
    queryFn: () =>
      query.trim()
        ? window.swarm.gmail.search(query.trim(), PAGE_LIMIT)
        : window.swarm.gmail.listRecent({ limit: PAGE_LIMIT }),
    enabled: linked,
  })

  const detail = useQuery({
    queryKey: ['gmail', 'thread', selectedId],
    queryFn: () => window.swarm.gmail.getThread(selectedId!),
    enabled: linked && selectedId !== null,
  })

  const refresh = async (): Promise<void> => {
    await window.swarm.gmail.syncNow()
    void qc.invalidateQueries({ queryKey: ['gmail'] })
  }

  const threads = list.data ?? []
  // classifyAll is a pure derivation; memoize on the thread list. Computed
  // before the early returns below so the hook order stays unconditional
  // (Rules of Hooks).
  const groupCounts = useMemo(() => classifyAll(threads), [threads])

  // Not linked: the cache is empty and unreadable. Point users at Settings.
  if (status.isPending) {
    return <CenteredMessage text="加载中…" />
  }
  if (!linked) {
    return (
      <CenteredMessage
        hint="在「设置 → Gmail」中连接账号后即可浏览收件箱"
        icon={<Inbox className="size-8 text-muted-foreground" />}
        text="未连接 Gmail 账号"
      />
    )
  }

  const visibleThreads = activeGroup === 'all' ? threads : threads.filter((t) => classifyThread(t) === activeGroup)

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 p-5">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-semibold text-foreground text-xl">Gmail 收件箱</h1>
            <p className="mt-0.5 text-muted-foreground text-sm">
              {status.data?.accountEmail ?? '已连接'}
              {status.data?.lastSyncAt ? ` · 上次同步 ${new Date(status.data.lastSyncAt).toLocaleString()}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <form
              onSubmit={(e) => {
                e.preventDefault()
                setQuery(draft.trim())
                setSelectedId(null)
              }}
            >
              <div className="flex items-center gap-2">
                <Input onChange={(e) => setDraft(e.target.value)} placeholder="搜索邮件…" value={draft} />
                <Button disabled={list.isFetching} size="icon-sm" type="submit" variant="outline">
                  {list.isFetching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                </Button>
              </div>
            </form>
            <Button disabled={status.isFetching} onClick={() => void refresh()} size="icon-sm" variant="outline">
              <RefreshCw className={cn('size-4', status.isFetching && 'animate-spin')} />
            </Button>
          </div>
        </div>
        <GmailGroupBar active={activeGroup} groups={groupCounts} onPick={setActiveGroup} />
      </header>

      <div className="flex min-h-0 flex-1 gap-4">
        {/* Thread list */}
        <div className="flex w-80 shrink-0 flex-col">
          {list.isPending ? (
            <ListSkeleton />
          ) : visibleThreads.length === 0 ? (
            <CenteredMessage text={query.trim() ? '没有匹配的邮件' : '收件箱为空'} />
          ) : (
            <ScrollArea className="-mr-2 min-h-0 flex-1 pr-2" edgeFade>
              <ol className="flex flex-col gap-1">
                {visibleThreads.map((t) => (
                  <li key={t.id}>
                    <button
                      className={cn(
                        'flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-card/80',
                        selectedId === t.id ? 'bg-card' : 'bg-card/40'
                      )}
                      onClick={() => setSelectedId(t.id)}
                      type="button"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className={cn(
                            'truncate text-sm',
                            t.unread ? 'font-semibold text-foreground' : 'text-foreground/80'
                          )}
                        >
                          {fromDisplay(t.fromAddr) || '(未知发件人)'}
                        </span>
                        <span className="shrink-0 text-muted-foreground text-xs">{formatListDate(t.lastDateMs)}</span>
                      </div>
                      <span className={cn('truncate text-xs', t.unread ? 'text-foreground' : 'text-foreground/70')}>
                        {t.subject || '(无主题)'}
                      </span>
                      <span className="line-clamp-1 text-muted-foreground text-xs">{t.snippet}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </ScrollArea>
          )}
        </div>

        {/* Thread detail */}
        <div className="min-w-0 flex-1">
          {selectedId === null ? (
            <CenteredMessage icon={<MailOpen className="size-8 text-muted-foreground" />} text="选择一封邮件查看" />
          ) : detail.isPending ? (
            <DetailSkeleton />
          ) : !detail.data ? (
            <CenteredMessage text="未找到该邮件" />
          ) : (
            <GmailThreadDetail data={detail.data} threadId={selectedId} />
          )}
        </div>
      </div>
    </div>
  )
}

// The right-hand detail column. Extracted as its own component so
// useThreadAnalysis (which calls hooks internally) is invoked unconditionally
// — never behind a conditional-render branch. The thread input handed to the
// hook is memoized on detail.data so it stays referentially stable across
// renders; otherwise every parent re-render would re-subscribe + re-trigger
// analyzeThread (the hook's effect deps include the thread object identity).
function GmailThreadDetail({
  data,
  threadId,
}: {
  data: { thread: { subject: string }; messages: GmailMessage[] }
  threadId: string
}): React.JSX.Element {
  // Build the hook input from the loaded detail. Memoized so the object
  // identity only changes when the underlying data actually changes — passing
  // an inline literal here would re-fire analysis on every render.
  const threadInput = useMemo(
    () => ({
      id: threadId,
      subject: data.thread.subject,
      messages: data.messages.map((m) => ({ from: m.fromAddr, dateMs: m.dateMs, bodyText: m.bodyText })),
    }),
    [threadId, data]
  )
  const analysis = useThreadAnalysis(threadInput)

  const regenerate = (): void => {
    // The hook's event subscription stays active after `done`, so re-firing
    // analyzeThread streams a fresh result into the same state machine.
    void swarmApi.analyzeThread({
      threadId: threadInput.id,
      subject: threadInput.subject,
      messages: threadInput.messages,
    })
  }

  return (
    <ScrollArea className="h-full pr-2" edgeFade>
      <div className="flex flex-col gap-4 pb-6">
        <div>
          <h2 className="font-semibold text-foreground text-lg">{data.thread.subject || '(无主题)'}</h2>
          <p className="mt-1 text-muted-foreground text-xs">{data.messages.length} 条消息</p>
        </div>
        <GmailAssistantCard analysis={analysis} messageCount={data.messages.length} onRegenerate={regenerate} />
        {data.messages.map((m) => (
          <MessageCard key={m.id} m={m} />
        ))}
      </div>
    </ScrollArea>
  )
}

function MessageCard({ m }: { m: GmailMessage }): React.JSX.Element {
  return (
    <article className="rounded-lg border border-border bg-card/60 p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-foreground text-sm">{fromDisplay(m.fromAddr) || '(未知发件人)'}</div>
          {m.toAddrs.length > 0 ? <div className="text-muted-foreground text-xs">致 {m.toAddrs.join(', ')}</div> : null}
        </div>
        <time className="shrink-0 text-muted-foreground text-xs">
          {m.dateMs ? new Date(m.dateMs).toLocaleString() : ''}
        </time>
      </header>
      {m.htmlBody ? (
        <EmailHtml html={m.htmlBody} />
      ) : (
        <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-foreground/90 text-sm">{m.bodyText}</pre>
      )}
    </article>
  )
}

export function MessageAnalysis({
  message,
  cached,
}: {
  message: GmailMessage
  cached?: GmailAnalysis
}): React.JSX.Element {
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'done' | 'error'>(cached ? 'done' : 'idle')
  const [text, setText] = useState<string>(cached?.analysis ?? '')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Subscribe once per message; events for other message ids are ignored.
    return window.swarm.subscribeEvents((e: UIEvent) => {
      if (e.kind === 'gmail.analysisDelta' && e.messageId === message.id) {
        setText((prev) => prev + e.text)
        setPhase('streaming')
      } else if (e.kind === 'gmail.analysisComplete' && e.messageId === message.id) {
        setText(e.markdown)
        setPhase('done')
        void window.swarm.gmail.saveAnalysis(message.id, e.markdown)
      } else if (e.kind === 'gmail.analysisError' && e.messageId === message.id) {
        setError(e.error)
        setPhase('error')
      }
    })
  }, [message.id])

  const analyze = (): void => {
    if (!message.bodyText.trim()) return
    setError(null)
    setText('')
    setPhase('streaming')
    void window.swarm.analyzeEmail({
      messageId: message.id,
      subject: message.subject,
      from: message.fromAddr,
      content: message.bodyText,
    })
  }

  return (
    <div className="mt-3 rounded-md border border-border/40 bg-background/40 p-3">
      {phase === 'idle' && (
        <Button disabled={!message.bodyText.trim()} onClick={analyze} size="sm" variant="outline">
          <Sparkles className="size-3.5" /> 分析
        </Button>
      )}
      {phase === 'error' && (
        <div className="flex items-center gap-2">
          <span className="text-destructive text-xs">{error ?? '分析失败'}</span>
          <Button onClick={analyze} size="sm" variant="outline">
            重试
          </Button>
        </div>
      )}
      {(phase === 'streaming' || phase === 'done') && (
        <div className="flex flex-col gap-2">
          {phase === 'streaming' && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          <Streamdown className="text-foreground/90 text-sm">{text}</Streamdown>
          {phase === 'done' && (
            <Button onClick={analyze} size="sm" variant="ghost">
              ↻ 重新分析
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function ListSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      {Array.from({ length: 8 }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <div className="flex flex-col gap-1 rounded-md bg-card/40 px-3 py-2" key={i}>
          <Skeleton className="h-3.5 w-2/3 rounded" />
          <Skeleton className="h-3 w-full rounded" />
          <Skeleton className="h-3 w-4/5 rounded" />
        </div>
      ))}
    </div>
  )
}

function DetailSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-5 w-1/2 rounded" />
      <Skeleton className="h-3 w-24 rounded" />
      <div className="mt-2 space-y-2">
        <Skeleton className="h-3 w-1/3 rounded" />
        <Skeleton className="h-3 w-full rounded" />
        <Skeleton className="h-3 w-full rounded" />
        <Skeleton className="h-3 w-5/6 rounded" />
      </div>
    </div>
  )
}

function CenteredMessage({
  icon,
  text,
  hint,
}: {
  icon?: React.ReactNode
  text: string
  hint?: string
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
      {icon}
      <p className="font-medium text-foreground text-sm">{text}</p>
      {hint ? <p className="max-w-xs text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  )
}
