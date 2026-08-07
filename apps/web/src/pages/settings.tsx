import { Button } from '@swarm/ui'
import { useNavigate } from 'react-router-dom'

import { useConnection } from '@/stores/connection-store'

export function SettingsPage(): React.JSX.Element {
  const { config, status, disconnect, reconnect } = useConnection()
  const navigate = useNavigate()

  const statusText =
    status === 'connected' ? '已连接' : status === 'connecting' ? '连接中…' : status === 'error' ? '连接错误' : '未连接'

  const handleDisconnect = (): void => {
    disconnect()
    navigate('/connect')
  }

  const handleReconnect = async (): Promise<void> => {
    const ok = await reconnect()
    if (!ok) await navigate('/connect')
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col bg-background">
      <header className="flex items-center gap-3 border-border border-b px-4 py-3">
        <Button aria-label="返回" onClick={() => navigate('/sessions')} size="icon" variant="ghost">
          ←
        </Button>
        <h1 className="font-semibold text-base text-foreground">连接设置</h1>
      </header>

      <div className="space-y-4 px-4 py-4">
        <div className="rounded-lg border border-border p-3">
          <p className="text-muted-foreground text-sm">状态</p>
          <p className="text-foreground text-sm">{statusText}</p>
        </div>

        {config && (
          <div className="rounded-lg border border-border p-3">
            <p className="text-muted-foreground text-sm">桌面端地址</p>
            <p className="font-mono text-foreground text-sm">
              {config.host}:{config.port}
            </p>
          </div>
        )}

        <div className="space-y-2">
          <Button className="w-full" disabled={status !== 'connected'} onClick={() => void handleReconnect()}>
            重新连接
          </Button>
          <Button className="w-full" onClick={handleDisconnect} variant="outline">
            断开连接
          </Button>
        </div>
      </div>
    </div>
  )
}
