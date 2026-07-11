import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import QRCode from 'qrcode'

import { Section, SettingsHeader } from './settings-primitives'

// Settings → 远程连接: displays the WS host config (port + token + LAN IP)
// and a QR code for mobile pairing. The QR encodes:
//   swarm:<lanIp>:<port>?token=<token>
// The mobile app scans this to connect over LAN.
export function RemoteView(): React.JSX.Element {
  const [config, setConfig] = useState<{ port: number; token: string; lanIp: string | null } | null>(null)
  const [copied, setCopied] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  useEffect(() => {
    void window.swarm.getWsHostConfig().then(setConfig)
  }, [])

  useEffect(() => {
    if (!config?.lanIp) {
      setQrDataUrl(null)
      return
    }
    const qrText = `swarm:${config.lanIp}:${config.port}?token=${config.token}`
    void QRCode.toDataURL(qrText, { width: 256, margin: 2 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null))
  }, [config])

  const copy = async (): Promise<void> => {
    if (!config) return
    await navigator.clipboard.writeText(config.token)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        description="浏览器插件和移动端通过此 token 连接到桌面端。移动端可扫描下方 QR 码直接配对。"
        title="远程连接"
      />
      <Section label="连接信息">
        {config ? (
          <div className="flex flex-col gap-3 py-1">
            {config.lanIp && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-sm">局域网 IP</span>
                <span className="font-mono text-sm">{config.lanIp}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm">端口</span>
              <span className="font-mono text-sm">{config.port}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-sm">Token</span>
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs">
                  {config.token}
                </code>
                <button
                  className="inline-flex size-8 items-center justify-center rounded border hover:bg-accent"
                  onClick={() => void copy()}
                  type="button"
                >
                  {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
                </button>
              </div>
            </div>
            {qrDataUrl ? (
              <div className="flex flex-col items-center gap-2 pt-2">
                <img alt="QR code for mobile pairing" className="rounded-lg border border-border" src={qrDataUrl} />
                <span className="text-muted-foreground text-xs">用手机扫描此 QR 码配对连接</span>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                {config.lanIp
                  ? 'QR 码生成失败，请手动输入连接信息。'
                  : '未检测到局域网 IP，无法生成 QR 码。请手动输入 token。'}
              </p>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">WS 主机未启动或不可用。</p>
        )}
      </Section>
    </div>
  )
}
