export function TitleBar(): React.JSX.Element {
  return (
    <div
      className="flex h-7 shrink-0 items-center px-3 text-xs text-muted-foreground"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <span className="ml-16 select-none">SwarmAgents</span>
    </div>
  )
}
