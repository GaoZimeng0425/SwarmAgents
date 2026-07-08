import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { Section, SettingsHeader } from './settings-primitives'

// Settings → 远程连接: displays the loopback WS host config (port + token) so
// the user can copy the token into the browser extension without digging
// through userData/ws-host.json. The token is main-only until requested here.
export function RemoteView(): React.JSX.Element {
  const [config, setConfig] = useState<{ port: number; token: string } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void window.swarm.getWsHostConfig().then(setConfig)
  }, [])

  const copy = async (): Promise<void> => {
    if (!config) return
    await navigator.clipboard.writeText(config.token)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        description="浏览器插件和移动端通过此 token 连接到桌面端。复制 token 粘贴到插件即可。"
        title="远程连接"
      />
      <Section label="连接信息">
        {config ? (
          <div className="flex flex-col gap-3 py-1">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm">端口</span>
              <span className="font-mono text-sm">{config.port}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-sm">Token</span>
              <div className="flex items-center gap-2">
                <code className="border-border bg-muted/40 flex-1 overflow-x-auto rounded border px-2 py-1.5 font-mono text-xs">
                  {config.token}
                </code>
                <button
                  className="hover:bg-accent inline-flex size-8 items-center justify-center rounded border"
                  onClick={() => void copy()}
                  type="button"
                >
                  {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">WS 主机未启动或不可用。</p>
        )}
      </Section>
    </div>
  )
}
