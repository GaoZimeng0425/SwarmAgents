import { useState } from 'react'
import { Button, Input, Label } from '@swarm/ui'
import { useNavigate } from 'react-router-dom'

import { type ConnectionConfig, parseConnectionConfig } from '@/lib/parse-config'
import { useConnection } from '@/stores/connection-store'

export function ConnectPage(): React.JSX.Element {
  const { connect, status, error } = useConnection()
  const navigate = useNavigate()
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [token, setToken] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setFormError(null)
    let cfg: ConnectionConfig
    try {
      cfg = parseConnectionConfig(host, port, token)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
      return
    }
    const ok = await connect(cfg)
    if (ok) navigate('/sessions')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm"
        onSubmit={(e) => void handleSubmit(e)}
      >
        <h1 className="font-semibold text-card-foreground text-xl">连接到桌面端</h1>
        <p className="text-muted-foreground text-sm">在桌面端打开「设置 → 远程连接」获取主机地址、端口和 Token。</p>

        <div className="space-y-1.5">
          <Label htmlFor="host">主机地址</Label>
          <Input id="host" onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.100" value={host} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="port">端口</Label>
          <Input id="port" onChange={(e) => setPort(e.target.value)} placeholder="47777" value={port} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="token">Token</Label>
          <Input
            id="token"
            onChange={(e) => setToken(e.target.value)}
            placeholder="swarm-xxxx"
            type="password"
            value={token}
          />
        </div>

        {(formError || error) && <p className="text-destructive text-sm">{formError ?? error}</p>}

        <Button className="w-full" disabled={status === 'connecting'} type="submit">
          {status === 'connecting' ? '连接中…' : '连接'}
        </Button>
      </form>
    </div>
  )
}
