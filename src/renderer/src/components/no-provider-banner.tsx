import { useNavigate } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { useProviders } from '@/hooks/use-providers'

export function NoProviderBanner(): React.JSX.Element | null {
  const { ready } = useProviders()
  const navigate = useNavigate()
  if (ready) return null

  return (
    <div className="flex items-center justify-between gap-3 border-amber-500/40 border-b bg-amber-500/10 px-4 py-2 text-sm">
      <span>⚠ No API key configured.</span>
      <Button
        onClick={() => {
          // biome-ignore lint/suspicious/noExplicitAny: widened over Router's typed registry
          void navigate({ to: '/settings/providers' as any })
        }}
        size="sm"
        variant="default"
      >
        Open Settings
      </Button>
    </div>
  )
}
