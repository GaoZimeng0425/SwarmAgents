// Settings view for the quick panel: displays the current global hotkey and
// lets the user rebind it by pressing a new key combination.
import { useCallback, useEffect, useState } from 'react'
import { Button, Kbd, KbdGroup } from '@swarm/ui'

import { swarmApi } from '@/lib/api'
import { Section, SettingsHeader } from './settings-primitives'

// Renderer-safe platform check — process.platform is not available here.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

// Map an Electron accelerator token to a display glyph.
function tokenToGlyph(token: string): string {
  switch (token) {
    case 'CommandOrControl':
    case 'Command':
      return IS_MAC ? '⌘' : 'Ctrl'
    case 'Control':
      return 'Ctrl'
    case 'Shift':
      return '⇧'
    case 'Alt':
    case 'AltGr':
      return IS_MAC ? '⌥' : 'Alt'
    case 'Space':
      return 'Space'
    default:
      // Single chars render uppercase (e.g. "k" -> "K"); named keys as-is.
      return token.length === 1 ? token.toUpperCase() : token
  }
}

function acceleratorTokens(accel: string): string[] {
  return accel
    .split('+')
    .map((t) => t.trim())
    .filter(Boolean)
}

// Convert a KeyboardEvent to an Electron accelerator string. Returns '' for a
// pure modifier press (we wait for an actual key before capturing).
function eventToAccelerator(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.metaKey) parts.push('Command')
  if (e.ctrlKey) parts.push('Control')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') return ''
  const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key
  parts.push(key)
  // On macOS translate Command -> CommandOrControl so the accelerator works
  // cross-platform (the stored value is portable, the glyph is localized above).
  if (IS_MAC && parts.includes('Command')) {
    parts[parts.indexOf('Command')] = 'CommandOrControl'
  }
  return parts.join('+')
}

export function QuickPanelSettingsView(): React.JSX.Element {
  const [hotkey, setHotkey] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void swarmApi.quickPanelGetHotkey().then(setHotkey)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!capturing) return
    const handler = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const accel = eventToAccelerator(e)
      if (!accel) return // pure modifier, wait for a real key
      void swarmApi.quickPanelSetHotkey(accel).then((result) => {
        if (result.ok) {
          setHotkey(accel)
          setError(null)
        } else {
          setError('该快捷键已被系统或其他应用占用')
        }
        setCapturing(false)
      })
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [capturing])

  return (
    <div className="space-y-5">
      <SettingsHeader description="全局快捷键唤起快捷面板,即使应用不在前台也能响应。" title="快捷面板" />
      <Section label="全局快捷键">
        <div className="flex items-center gap-3 py-1">
          <span className="text-sm">当前快捷键</span>
          {hotkey ? (
            <KbdGroup>
              {acceleratorTokens(hotkey).map((tok) => (
                <Kbd key={tok}>{tokenToGlyph(tok)}</Kbd>
              ))}
            </KbdGroup>
          ) : (
            <span className="text-muted-foreground text-sm">未设置</span>
          )}
          <Button
            onClick={() => {
              setCapturing(true)
              setError(null)
            }}
            size="sm"
            variant={capturing ? 'secondary' : 'outline'}
          >
            {capturing ? '按下新的快捷键…' : '重新绑定'}
          </Button>
        </div>
        {error && <p className="text-destructive text-sm">{error}</p>}
      </Section>
    </div>
  )
}
