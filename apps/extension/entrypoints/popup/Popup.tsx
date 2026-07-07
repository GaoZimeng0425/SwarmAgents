import { type JSX, useState } from 'react'
import { Button } from '@swarm/ui'

type ProbeResult = { ok: true; count: number } | { ok: false; error: string }

type CollectStatus = { kind: 'pending' } | { kind: 'ok'; articleId?: string } | { kind: 'err'; error: string }

export function Popup(): JSX.Element {
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
    <div style={{ fontFamily: 'system-ui', width: 320, padding: 12 }}>
      <h3 style={{ margin: '0 0 8px' }}>SwarmAgents</h3>
      <p style={{ fontSize: 12, color: '#666', margin: '0 0 8px' }}>
        Skeleton — verifies the extension can reach the desktop runtime over WS.
      </p>
      <Button className="w-full" disabled={busy} onClick={probe}>
        {busy ? '…' : 'test connection'}
      </Button>
      {result?.ok && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#555' }}>
          connected — {result.count} agents visible on the desktop.
        </div>
      )}
      {result && !result.ok && <div style={{ marginTop: 8, fontSize: 12, color: '#c00' }}>error: {result.error}</div>}

      <Button className="w-full" disabled={collecting || !connected} onClick={collect} style={{ marginTop: 12 }}>
        📄 收集当前页到文章库
      </Button>
      {collectStatus?.kind === 'pending' && <div style={{ marginTop: 8, fontSize: 12, color: '#555' }}>◷ 发送中…</div>}
      {collectStatus?.kind === 'ok' && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#080' }}>✓ 已收集,去 desktop 查看</div>
      )}
      {collectStatus?.kind === 'err' && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#c00' }}>✗ {collectStatus.error}</div>
      )}

      <div style={{ marginTop: 8 }}>
        <Button onClick={() => browser.runtime.openOptionsPage()} variant="link">
          options
        </Button>
      </div>
    </div>
  )
}
