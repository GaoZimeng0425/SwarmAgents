import { type JSX, useState } from 'react'
import { Button } from '@swarm/ui'

type ProbeResult = { ok: true; count: number } | { ok: false; error: string }

export function Popup(): JSX.Element {
  const [result, setResult] = useState<ProbeResult | null>(null)
  const [busy, setBusy] = useState(false)

  const probe = (): void => {
    setBusy(true)
    setResult(null)
    browser.runtime.sendMessage({ type: 'listAgents' }, (r: ProbeResult) => {
      setResult(r)
      setBusy(false)
    })
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
      <div style={{ marginTop: 8 }}>
        <Button onClick={() => browser.runtime.openOptionsPage()} variant="link">
          options
        </Button>
      </div>
    </div>
  )
}
