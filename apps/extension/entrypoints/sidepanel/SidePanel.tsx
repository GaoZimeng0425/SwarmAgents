// The extension's side panel (replaces the popup). Chrome MV3 `chrome.sidePanel`:
// click the toolbar icon → `action.onClicked` (background) opens this panel on
// the right edge. Unlike a popup it stays open while the user browses, so it
// doubles as a status surface for "收集当前页".
//
// Config is inline (no separate options page hop): on open the panel probes
// `health` (a listAgents round-trip); only when that fails does it show the
// token form. Saving writes browser.storage.local and the background (which
// watches storage.onChanged) reconnects automatically, after which the next
// health probe flips the panel back to the connected view.
import { type JSX, useEffect, useState } from 'react'
import { Button } from '@swarm/ui'

type HealthResult = { ok: true; count: number } | { ok: false; error: string }

type CollectStatus = { kind: 'pending' } | { kind: 'ok'; articleId?: string } | { kind: 'err'; error: string }

export function SidePanel(): JSX.Element {
  // Connection + collect state. `connected` is driven solely by the health
  // probe — there is no manual "测试连接" button anymore.
  const [connected, setConnected] = useState(false)
  const [collecting, setCollecting] = useState(false)
  const [collectStatus, setCollectStatus] = useState<CollectStatus | null>(null)

  // Config state (inline). wsHost defaults to the loopback WS; only token is
  // required. The form is shown only when health fails.
  const [wsHost, setWsHost] = useState('ws://127.0.0.1:47777')
  const [token, setToken] = useState('')
  const [savedHint, setSavedHint] = useState(false)

  // Prefill the form from storage so it's ready when shown.
  useEffect(() => {
    browser.storage.local.get(['wsHost', 'token']).then((v) => {
      if (v.wsHost) setWsHost(v.wsHost as string)
      if (v.token) setToken(v.token as string)
    })
  }, [])

  // Probe health on mount AND retry every 3s while still unhealthy. The WS
  // client in the background reconnects asynchronously (on storage change /
  // alarm), so a one-shot probe at mount would often race ahead of the
  // connection and leave the token form stuck open. Retrying until success
  // means the form disappears the moment the connection actually comes up.
  // Stops retrying once connected or the panel unmounts.
  useEffect(() => {
    let stopped = false
    const probe = (): void => {
      browser.runtime.sendMessage({ type: 'health' }, (r: HealthResult) => {
        if (stopped) return
        if (r?.ok) {
          setConnected(true)
        } else {
          setConnected(false)
          setTimeout(probe, 3000)
        }
      })
    }
    probe()
    return () => {
      stopped = true
    }
  }, [])

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
      // need to message it directly. Briefly flash a hint; a subsequent health
      // probe (e.g. on next panel open) will re-establish the connected view.
      setSavedHint(true)
      setTimeout(() => setSavedHint(false), 2500)
    })
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <header className="flex flex-col gap-1">
        <h3 className="font-semibold text-foreground">SwarmAgents</h3>
        <p className="text-muted-foreground text-xs">连接桌面端,收集当前页文章并发送分析。</p>
      </header>

      {/* Inline config: shown only when not connected (health failed). */}
      {!connected ? (
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
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <Button className="w-full" disabled={collecting || !connected} onClick={collect}>
          📄 收集当前页到文章库
        </Button>
        {connected && <p className="text-muted-foreground text-xs">已连接 — 可收集当前页。</p>}
        {collectStatus?.kind === 'pending' && <p className="text-muted-foreground text-xs">◷ 发送中…</p>}
        {collectStatus?.kind === 'ok' && <p className="text-xs text-emerald-600">✓ 已收集,去 desktop 查看</p>}
        {collectStatus?.kind === 'err' && <p className="text-destructive text-xs">✗ {collectStatus.error}</p>}
      </section>
    </div>
  )
}
