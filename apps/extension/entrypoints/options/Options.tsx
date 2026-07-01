import { useEffect, useState } from 'react'

export function Options(): JSX.Element {
  const [wsHost, setWsHost] = useState('ws://127.0.0.1:47777')
  const [token, setToken] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    browser.storage.local.get(['wsHost', 'token']).then((v) => {
      if (v.wsHost) setWsHost(v.wsHost as string)
      if (v.token) setToken(v.token as string)
    })
  }, [])

  return (
    <div style={{ fontFamily: 'system-ui', padding: 16, maxWidth: 480 }}>
      <h2>SwarmAgents</h2>
      <p style={{ color: '#666', fontSize: 13 }}>
        Copy the token from the desktop's <code>userData/ws-host.json</code>.
      </p>
      <label>WS host</label>
      <input value={wsHost} onChange={(e) => setWsHost(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
      <label>Token</label>
      <input value={token} onChange={(e) => setToken(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
      <button
        onClick={() => {
          browser.storage.local.set({ wsHost, token }).then(() => setSaved(true))
        }}
      >
        Save
      </button>
      {saved && <span style={{ color: 'green', marginLeft: 8 }}>saved — background will reconnect</span>}
    </div>
  )
}
