// The extension's side panel (replaces the popup). Chrome MV3 `chrome.sidePanel`:
// click the toolbar icon → `action.onClicked` (background) opens this panel on
// the right edge. Unlike a popup it stays open while the user browses, so it
// doubles as a status surface for "收集当前页".
//
// Config is inline (no separate options page hop): when disconnected the panel
// shows a token field; saving writes browser.storage.local and the background
// (which watches storage.onChanged) reconnects automatically.
import { type JSX, useEffect, useState } from 'react'
import { Button } from '@swarm/ui'

type ProbeResult = { ok: true; count: number } | { ok: false; error: string }

type CollectStatus = { kind: 'pending' } | { kind: 'ok'; articleId?: string } | { kind: 'err'; error: string }

export function SidePanel(): JSX.Element {
  // Connection + collect state
  const [result, setResult] = useState<ProbeResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [collecting, setCollecting] = useState(false)
  const [collectStatus, setCollectStatus] = useState<CollectStatus | null>(null)

  // Config state (inline). wsHost defaults to the loopback WS; only token is
  // required. showConfig forces the form open when the user clicks "设置".
  const [wsHost, setWsHost] = useState('ws://127.0.0.1:47777')
  const [token, setToken] = useState('')
  const [showConfig, setShowConfig] = useState(false)
  const [savedHint, setSavedHint] = useState(false)

  const connected = result?.ok === true

  useEffect(() => {
    browser.storage.local.get(['wsHost', 'token']).then((v) => {
      if (v.wsHost) setWsHost(v.wsHost as string)
      if (v.token) setToken(v.token as string)
    })
  }, [])

  // Auto-open the config form while disconnected (no point hiding the token
  // field behind a click when the user can't use the panel yet).
  useEffect(() => {
    if (result && !result.ok) setShowConfig(true)
  }, [result])

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

  const saveConfig = (): void => {
    browser.storage.local.set({ wsHost, token }).then(() => {
      // The background watches storage.onChanged and reconnects on its own; no
      // need to message it directly. Briefly flash a hint, then let the user
      // hit "测试连接" once the background has had a tick to reconnect.
      setSavedHint(true)
      setShowConfig(false)
      setTimeout(() => setSavedHint(false), 2500)
    })
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <header className="flex flex-col gap-1">
        <h3 className="font-semibold text-foreground">SwarmAgents</h3>
        <p className="text-muted-foreground text-xs">连接桌面端,收集当前页文章并发送分析。</p>
      </header>

      {/* Inline config: shown when disconnected or explicitly toggled. */}
      {!connected || showConfig ? (
        <section className="flex flex-col gap-2 rounded-md border border-border p-3">
          <label className="text-muted-foreground text-xs" htmlFor="token">
            Token(从桌面端 ws-host.json 复制)
          </label>
          <input
            className="border-border bg-background rounded border px-2 py-1 font-mono text-xs"
            id="token"
            onChange={(e) => setToken(e.target.value)}
            placeholder="粘贴 token"
            type="password"
            value={token}
          />
          <details className="text-muted-foreground text-xs">
            <summary className="cursor-pointer select-none">高级(WS host)</summary>
            <input
              className="border-border bg-background mt-2 w-full rounded border px-2 py-1 font-mono text-xs"
              onChange={(e) => setWsHost(e.target.value)}
              value={wsHost}
            />
          </details>
          <Button className="mt-1" disabled={token.trim().length === 0} onClick={saveConfig} size="sm">
            保存并重连
          </Button>
          {savedHint && <p className="text-xs text-emerald-600">已保存,后台正在重连…</p>}
          {result && !result.ok && <p className="text-destructive text-xs">连接失败:{result.error}</p>}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <Button className="w-full" disabled={busy || token.trim().length === 0} onClick={probe}>
          {busy ? '…' : '测试连接'}
        </Button>
        {connected && <p className="text-muted-foreground text-xs">已连接 — desktop 可见 {result?.count} 个 agent。</p>}
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

      <div className="mt-auto flex items-center justify-between">
        {connected ? (
          <button
            className="text-muted-foreground text-xs underline"
            onClick={() => setShowConfig((v) => !v)}
            type="button"
          >
            设置
          </button>
        ) : null}
        <Button onClick={() => browser.runtime.openOptionsPage()} variant="link">
          打开独立选项页
        </Button>
      </div>
    </div>
  )
}
