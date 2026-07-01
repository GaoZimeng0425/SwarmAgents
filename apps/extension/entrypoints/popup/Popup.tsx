import { useState } from 'react'

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
      <button disabled={busy} onClick={probe} style={{ width: '100%' }}>
        {busy ? '…' : 'test connection'}
      </button>
      {result?.ok && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#555' }}>
          connected — {result.count} agents visible on the desktop.
        </div>
      )}
      {result && !result.ok && <div style={{ marginTop: 8, fontSize: 12, color: '#c00' }}>error: {result.error}</div>}
      <div style={{ marginTop: 8 }}>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault()
            browser.runtime.openOptionsPage()
          }}
        >
          options
        </a>
      </div>
    </div>
  )
}
