// Shared empty-state card for the dashboard sections: a solid rounded card with
// a centered muted icon and a single line of copy. Replaces the ad-hoc dashed /
// solid boxes the sections used before, so every empty state reads identically.
import type { LucideIcon } from 'lucide-react'

export function DashboardEmpty({
  icon: Icon,
  children,
}: {
  icon: LucideIcon
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-card px-4 py-8 text-center">
      <Icon aria-hidden="true" className="size-5 text-muted-foreground/70" />
      <p className="text-[13px] text-muted-foreground">{children}</p>
    </div>
  )
}
