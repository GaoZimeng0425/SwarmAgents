import { Button } from '@/components/ui/button'
import { useProviders } from '@/hooks/use-providers'
import { useSettingsDialog } from '@/stores/settings-dialog'

export function NoProviderBanner(): React.JSX.Element | null {
  const { ready } = useProviders()
  const openSettings = useSettingsDialog((s) => s.openSettings)
  if (ready) return null

  return (
    <div className="flex items-center justify-between gap-3 border-amber-500/40 border-b bg-amber-500/10 px-4 py-2 text-sm">
      <span>⚠ No API key configured.</span>
      <Button onClick={() => openSettings('providers')} size="sm" variant="default">
        Open Settings
      </Button>
    </div>
  )
}
