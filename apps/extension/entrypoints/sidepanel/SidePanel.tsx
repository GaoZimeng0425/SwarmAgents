// The extension's side panel (replaces the popup). Chrome MV3 `chrome.sidePanel`:
// click the toolbar icon → `action.onClicked` (background) opens this panel on
// the right edge. Unlike a popup it stays open while the user browses, so it
// doubles as a status surface for "收集当前页".
import { type JSX, useState } from 'react'
import { Button } from '@swarm/ui'

type ProbeResult = { ok: true; count: number } | { ok: false; error: string }

type CollectStatus = { kind: 'pending' } | { kind: 'ok'; articleId?: string } | { kind: 'err'; error: string }

export function SidePanel(): JSX.Element {
  const [result, setResult] = useState<ProbeResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [collecting, setCollecting] = useState(false)
  const [collectStatus, setCollectStatus] = useState<CollectStatus | null>(null)

  const connected = result?.ok === true

  const probe = (): void => {
    setBusy(true)
    setResult(null)
    browser.runtime.sendMessage({ type: 'listAgents' }, (r: ProbeResult) => {
      setResult(r)
      setBusy(false)
    })
  }

  const collect = (): void => {
    setCollecting(true)
    setCollectStatus({ kind: 'pending' })
    browser.runtime.sendMessage(
      { type: 'collectCurrentPage' },
      (r: { ok: boolean; articleId?: string; error?: string }) => {
        if (r?.ok) setCollectStatus({ kind: 'ok', articleId: r.articleId })
        else setCollectStatus({ kind: 'err', error: r?.error ?? 'unknown error' })
        setCollecting(false)
      }
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <header className="flex flex-col gap-1">
        <h3 className="font-semibold text-foreground">SwarmAgents</h3>
        <p className="text-muted-foreground text-xs">连接桌面端,收集当前页文章并发送分析。</p>
      </header>

      <section className="flex flex-col gap-2">
        <Button className="w-full" disabled={busy} onClick={probe}>
          {busy ? '…' : '测试连接'}
        </Button>
        {result?.ok && (
          <p className="text-muted-foreground text-xs">已连接 — desktop 可见 {result.count} 个 agent。</p>
        )}
        {result && !result.ok && <p className="text-destructive text-xs">错误:{result.error}</p>}
      </section>

      <div className="border-border border-t" />

      <section className="flex flex-col gap-2">
        <Button className="w-full" disabled={collecting || !connected} onClick={collect}>
          📄 收集当前页到文章库
        </Button>
        {collectStatus?.kind === 'pending' && <p className="text-muted-foreground text-xs">◷ 发送中…</p>}
        {collectStatus?.kind === 'ok' && <p className="text-xs text-emerald-600">✓ 已收集,去 desktop 查看</p>}
        {collectStatus?.kind === 'err' && <p className="text-destructive text-xs">✗ {collectStatus.error}</p>}
      </section>

      <div className="mt-auto">
        <Button onClick={() => browser.runtime.openOptionsPage()} variant="link">
          打开选项(配置 token)
        </Button>
      </div>
    </div>
  )
}
