// Shared settings-tab style primitives, lifted from providers-view so every
// tab shares one header + section visual language.

export function SettingsHeader({
  title,
  description,
  action,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="font-medium text-lg">{title}</h2>
        {description && <p className="mt-1 text-muted-foreground text-sm">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function Section({ label, children }: { label: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="font-medium text-sm">{label}</div>
      {children}
    </div>
  )
}
