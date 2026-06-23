import { useCallback, useEffect, useState } from 'react'
import type { MacPermissionState, MacPermissions } from '@shared/types/ui'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const STATE_LABEL: Record<MacPermissionState, { text: string; variant: 'secondary' | 'destructive' | 'outline' }> = {
  granted: { text: 'Granted', variant: 'secondary' },
  denied: { text: 'Not granted', variant: 'destructive' },
  'not-determined': { text: 'Not set', variant: 'outline' },
  unsupported: { text: 'N/A', variant: 'outline' },
}

export function PermissionsView(): React.JSX.Element {
  const [perms, setPerms] = useState<MacPermissions | null>(null)

  const refresh = useCallback(() => {
    void window.swarm.getMacPermissions().then(setPerms)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const isMac = perms !== null && perms.screenRecording !== 'unsupported'

  return (
    <div className="max-w-xl space-y-6">
      <section className="space-y-2">
        <h2 className="font-medium text-lg">Permissions</h2>
        <p className="text-muted-foreground text-sm">
          Default policy: prompt on medium and high. Per-tool overrides coming in a later release.
        </p>
      </section>

      {isMac && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-sm">macOS System Access</h3>
            <Button onClick={refresh} size="sm" variant="ghost">
              Re-check
            </Button>
          </div>
          <p className="text-muted-foreground text-sm">
            The screen tools (see_screen, list_apps) need these. Grant them in System Settings, then re-check. Screen
            Recording changes may require relaunching SwarmAgents.
          </p>
          <PermissionRow
            hint="Capturing the screen for see_screen."
            label="Screen Recording"
            onOpen={() => void window.swarm.openPrivacySettings('screen')}
            state={perms.screenRecording}
          />
          <PermissionRow
            hint="Reading on-screen UI elements (and future click/type)."
            label="Accessibility"
            onOpen={() => void window.swarm.openPrivacySettings('accessibility')}
            state={perms.accessibility}
          />
        </section>
      )}
    </div>
  )
}

type RowProps = { label: string; hint: string; state: MacPermissionState; onOpen: () => void }

function PermissionRow({ label, hint, state, onOpen }: RowProps): React.JSX.Element {
  const meta = STATE_LABEL[state]
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{label}</span>
          <Badge variant={meta.variant}>{meta.text}</Badge>
        </div>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>
      <Button onClick={onOpen} size="sm" variant="outline">
        Open Settings
      </Button>
    </div>
  )
}
